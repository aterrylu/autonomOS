import { Hono } from "hono";
import { verifyAgentToken } from "../agentCredentials.js";
import { notePromptHookEvent } from "../agents/promptDelivery.js";
import { getAgent, listAgents } from "../agents/store.js";
import { getProvider } from "../providers/index.js";

/**
 * Hook events received from spawned agent sessions (any provider) via the
 * inline `HOOK_CMD` curl in providers/shared.ts, which posts over the internal
 * control socket. Tracks agent status (working, idle, needs input) and
 * notifications.
 *
 * (The `hooks/autonomos-relay.sh` script this comment used to name is not
 * wired into any spawn path — HOOK_CMD superseded it.)
 */

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    // SendUserMessage fields (when --brief is active)
    message?: string;
    status?: "normal" | "proactive";
    attachments?: string[];
  };
  notification_type?: string;
  source?: string;
  [key: string]: unknown;
}

export interface SessionNotification {
  event: string;
  message?: string;
  timestamp: number;
  read: boolean;
  /** True when SendUserMessage was sent with status: "proactive" */
  proactive?: boolean;
  /** Present on retractable notifications (SystemWarning) so the emitter can
   *  withdraw one that turned out to be premature. */
  id?: string;
}

export type AgentStatus =
  | "unknown"
  | "ready"
  | "working"
  | "tool_running"
  | "idle"
  | "needs_input"
  | "error"
  | "compacting"
  | "orchestrating"
  | "stopped";

export interface AgentState {
  status: AgentStatus;
  currentTool?: string;
  toolDetail?: string;
  lastEvent: string;
  updatedAt: number;
  /** Status saved when entering "compacting" (on PreCompact) so a compaction
   *  resolve signal (PostCompact OR SessionStart source=compact) can restore it.
   *  Cleared once resolved, or when any non-compaction status change ends the
   *  interlude. Undefined when no meaningful baseline exists (e.g. cold-start +
   *  auto-compact on session resume). See ADR-053. */
  preCompactStatus?: AgentStatus;
}

const DEFAULT_AGENT_STATE: AgentState = {
  status: "unknown",
  lastEvent: "",
  updatedAt: 0,
};

/** Fields to clear when a tool finishes or the agent transitions away from tool use */
const CLEAR_TOOL = {
  currentTool: undefined,
  toolDetail: undefined,
} as const;

// In-memory stores — keyed by autonomOS session ID
const notifications = new Map<string, SessionNotification[]>();
const agentStates = new Map<string, AgentState>();

/** Events that can transition OUT of idle/stopped state.
 *  Late-arriving PostToolUse, SubagentStop, etc. are ignored when idle. */
const IDLE_EXIT_EVENTS = new Set([
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
  "Notification",
  "PreToolUse",
]);

// ── Compaction resolution (order-independent) ────────────────────────
// CC emits the compaction hooks — PreCompact, the summarizer's SubagentStop,
// SessionStart(source=compact), and PostCompact — within ~90ms of each other
// as async fire-and-forget curls, so they can arrive in ANY order. The router
// (not deriveStatus) owns compaction so it can treat SessionStart(compact) and
// PostCompact as idempotent "compaction resolved" signals. See ADR-053.

/** Statuses that don't survive the JSONL collapse — a restored baseline of one
 *  of these is coerced to "working" so the turn continues cleanly rather than
 *  showing a phantom tool/prompt, or (for "compacting") re-stranding on the very
 *  spinner we're trying to clear if a duplicate PreCompact ever poisoned it. */
const STALE_ON_RESTORE = new Set<AgentStatus>([
  "tool_running",
  "needs_input",
  "error",
  "compacting",
]);

/** Statuses PreCompact enters "compacting" FROM — an allowlist of genuinely
 *  active turns worth showing as interrupted. Fail-safe by construction: any
 *  other state (idle/stopped/ready/unknown = at rest with no turn to interrupt;
 *  "compacting" = a duplicate/overlapping PreCompact) is a no-op, so PreCompact
 *  can never strand an at-rest agent or overwrite a live baseline with its own
 *  spinner state. See ADR-053. */
const COMPACT_ENTER_FROM = new Set<AgentStatus>([
  "working",
  "tool_running",
  "orchestrating",
  "needs_input",
  "error",
]);

/** Resolve a compaction back to a non-spinning status: restore the saved
 *  baseline (coercing transient states to "working"), or "ready" when no
 *  baseline was captured (resume auto-compact from a cold in-memory store). */
function restoredStatus(baseline: AgentStatus | undefined): AgentStatus {
  if (baseline === undefined) return "ready";
  return STALE_ON_RESTORE.has(baseline) ? "working" : baseline;
}

/** Events that generate a user-visible notification badge */
const NOTIFY_EVENTS = new Set(["Notification", "Stop", "PermissionRequest"]);

// ── Notification helpers ─────────────────────────────────────────────

export function getNotifications(sessionId: string): SessionNotification[] {
  return notifications.get(sessionId) ?? [];
}

export function getUnreadCount(sessionId: string): number {
  return getNotifications(sessionId).filter((n) => !n.read).length;
}

export function markRead(sessionId: string): void {
  const items = notifications.get(sessionId);
  if (items) {
    for (const n of items) n.read = true;
  }
}

export function clearNotifications(sessionId: string): void {
  notifications.delete(sessionId);
}

/** Append a notification for a session, capped at the 50 most recent. */
function appendNotification(
  sessionId: string,
  item: SessionNotification,
): void {
  const items = notifications.get(sessionId) ?? [];
  items.push(item);
  if (items.length > 50) items.splice(0, items.length - 50);
  notifications.set(sessionId, items);
}

let nextNotificationId = 0;

/**
 * Record a server-originated warning against a session (e.g. prompt
 * re-delivery). Surfaces in the bulk notification panel alongside
 * SendUserMessage — these warnings exist precisely for the operator to see.
 *
 * Returns an id the emitter can pass to retractSystemNotification if the
 * warned condition later proves transient (e.g. a channel server that
 * registers after the grace window) — a stale warning the operator acts on
 * is worse than no warning.
 */
export function pushSystemNotification(
  sessionId: string,
  message: string,
): string {
  const id = `sw-${++nextNotificationId}`;
  appendNotification(sessionId, {
    event: "SystemWarning",
    message,
    timestamp: Date.now(),
    read: false,
    id,
  });
  return id;
}

/** Withdraw a previously pushed SystemWarning. No-op if it already scrolled
 *  out of the 50-item cap, was cleared, or the id is unknown. The event guard
 *  makes the "retractable = SystemWarning" contract self-enforcing — if a
 *  second notification type ever mints ids, this must not become a
 *  cross-type delete. */
export function retractSystemNotification(
  sessionId: string,
  notificationId: string,
): boolean {
  const items = notifications.get(sessionId);
  if (!items) return false;
  const idx = items.findIndex(
    (n) => n.id === notificationId && n.event === "SystemWarning",
  );
  if (idx === -1) return false;
  items.splice(idx, 1);
  if (items.length === 0) notifications.delete(sessionId);
  return true;
}

// ── Agent status helpers ─────────────────────────────────────────────

export function getAgentState(sessionId: string): AgentState {
  return agentStates.get(sessionId) ?? DEFAULT_AGENT_STATE;
}

export function clearAgentState(sessionId: string): void {
  agentStates.delete(sessionId);
}

/**
 * Directly set an agent's working status. For providers that report GROUND-TRUTH
 * status out-of-band rather than through the hook relay + deriveStatus state
 * machine — currently Codex, whose app-server daemon emits thread/status/changed
 * (active/idle). No event synthesis needed: the daemon already tells us the
 * status, so we set it. The dashboard polls /api/hooks for this, same as CC/Gemini.
 */
export function setAgentStatus(sessionId: string, status: AgentStatus): void {
  const prev = agentStates.get(sessionId) ?? DEFAULT_AGENT_STATE;
  if (prev.status === status) return; // no churn on repeats
  agentStates.set(sessionId, {
    ...prev,
    ...CLEAR_TOOL,
    status,
    lastEvent: "provider/status",
    updatedAt: Date.now(),
  });
}

/** Derive agent status from a hook event.
 *
 * Tool failures (PostToolUseFailure) are routine — the agent handles them
 * and continues working. We record the failed tool as metadata but keep
 * the status as "working" so the UI doesn't flicker between warning and
 * in-progress when errors happen during normal flow.
 */
function deriveStatus(event: HookEvent): Partial<AgentState> {
  switch (event.hook_event_name) {
    case "SessionStart":
      // SessionStart(source=compact) is a compaction resolve signal handled
      // upstream in the router (order-independent); it never reaches here.
      // Every other SessionStart (startup, resume, clear) means "ready".
      return { status: "ready" };

    case "UserPromptSubmit":
    case "PostToolUse":
      return { status: "working", ...CLEAR_TOOL };

    case "PreToolUse":
      // SendUserMessage/Brief is a notification-only tool — don't show as tool_running
      if (event.tool_name === "SendUserMessage" || event.tool_name === "Brief")
        return {};
      return {
        status: "tool_running",
        currentTool: event.tool_name,
        toolDetail: extractToolDetail(event),
      };

    case "PostToolUseFailure":
      // Tool failures are normal during agent work (e.g., bash exits non-zero).
      // Keep status as "working" — the agent will handle the error and continue.
      return {
        status: "working",
        currentTool: event.tool_name,
        toolDetail: extractToolDetail(event),
      };

    case "Stop":
      return { status: "idle", ...CLEAR_TOOL };

    case "Notification":
      // Only permission prompts change status — other notifications
      // (progress, info, etc.) should not override the current status
      if (event.notification_type === "permission_prompt") {
        return { status: "needs_input" };
      }
      return {};

    case "PermissionRequest":
      return { status: "needs_input" };

    case "SubagentStart":
      return { status: "orchestrating" };

    case "SubagentStop":
      return { status: "working", ...CLEAR_TOOL };

    // PreCompact, PostCompact and SessionStart(source=compact) are handled in
    // the router as order-independent compaction signals, not here — their
    // correct status depends on prior state + delivery order. See ADR-053.

    case "SessionEnd":
      return { status: "stopped", ...CLEAR_TOOL };

    default:
      return {};
  }
}

/** Extract a short detail string from tool input (filename or truncated command) */
function extractToolDetail(event: HookEvent): string | undefined {
  const input = event.tool_input;
  if (!input) return undefined;

  if (input.file_path) {
    return input.file_path.split("/").pop();
  }
  if (input.command) {
    return input.command.length > 40
      ? `${input.command.slice(0, 37)}...`
      : input.command;
  }
  return undefined;
}

// ── Routers ──────────────────────────────────────────────────────────
//
// `/api/hooks` looks like one surface but is two, split along a trust boundary
// (ADR-055):
//
//   INGEST — `POST /:sessionId`, written to by spawned agents. Served ONLY on
//     the internal Unix socket. This is the route that used to accept
//     unauthenticated writes from anywhere on the network (the residual
//     ADR-054 left open): a hook post drives agent status and notifications,
//     so anyone who could reach it could forge either. On the socket it is
//     reachable only by same-user on-box processes — i.e. actual agents.
//
//   READ — everything else, called by the DASHBOARD (browser). Stays on the
//     public listener behind the token, because that is where the browser is.
//     Moving these to the socket would blind the notification panel and the
//     sidebar's status poll.
//
// They are separate Hono instances rather than one router mounted twice: the
// whole point is that ingest is NOT reachable publicly, which a shared mount
// would silently undo.

export const hooksIngestRouter = new Hono();

// Receive hook events from agent sessions (any provider).
// Providers may emit native event names (e.g. Gemini's "BeforeTool") — the
// provider's optional normalizeEvent() translates them to CC-shaped vocabulary
// before deriveStatus consumes them. CC has no translator (identity).
hooksIngestRouter.post("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  // Per-agent identity (ADR-055 PR B): a hook post must carry the token minted
  // for THIS session. The socket already restricts ingest to same-user on-box
  // processes; this additionally stops one agent forging status/notifications
  // for another agent's session. Fail-closed — an unknown session has no minted
  // token (verifyAgentToken returns false), so a stale hook from a dead session
  // is rejected rather than mutating state under a defunct id.
  if (!verifyAgentToken(sessionId, c.req.header("X-Agent-Token"))) {
    console.warn(
      `[hooks] ${sessionId.slice(0, 8)} rejected — missing or invalid per-agent token`,
    );
    return c.json({ error: "Invalid agent credential" }, 401);
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await c.req.json();
  } catch (err) {
    console.warn(
      `[hooks] ${sessionId.slice(0, 8)} invalid JSON from hook relay:`,
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Translate provider-native event names to CC vocabulary if the provider
  // supplies a normalizer. Skip translation when the session is unknown —
  // silently coercing a stale hook to "claude-code" would mistranslate a
  // straggling Gemini event from a session that already exited.
  const agent = getAgent(sessionId);
  let body: HookEvent;
  if (!agent) {
    console.debug(
      `[hooks] ${sessionId.slice(0, 8)} hook for unknown session — passing through without translation (raw=${String(rawBody.hook_event_name)})`,
    );
    body = rawBody as HookEvent;
  } else {
    const provider = getProvider(agent.provider ?? "claude-code");
    const normalized = provider.normalizeEvent?.(rawBody);
    if (normalized === null) {
      // Provider explicitly dropped this event (logged with reason at
      // provider level). Echo at the route level for sessionId correlation.
      console.debug(
        `[hooks] ${sessionId.slice(0, 8)} provider=${provider.name} dropped event: ${String(rawBody.hook_event_name)}`,
      );
      return c.json({ ok: true, event: "dropped", sessionId });
    }
    body = (normalized ?? rawBody) as HookEvent;
  }
  const event = body.hook_event_name ?? "unknown";
  const timestamp = Date.now();

  // Prompt delivery receipt — sessions spawned with a starting prompt are
  // tracked until UserPromptSubmit (or turn activity) confirms delivery.
  notePromptHookEvent(
    sessionId,
    event,
    typeof body.source === "string" ? body.source : undefined,
  );

  // ── Update agent status ────────────────────────────────────────────
  // Compaction is handled here (not deriveStatus) so it stays correct no
  // matter what order the compaction hooks arrive in. CC fires PreCompact,
  // the summarizer's SubagentStop, SessionStart(source=compact) and
  // PostCompact within ~90ms as async fire-and-forget curls — delivery order
  // is non-deterministic, so the previous single-order assumption stranded
  // agents at "compacting" for ~2 of 6 orderings. See ADR-053.
  const prev = getAgentState(sessionId);
  const isCompactResolve =
    event === "PostCompact" ||
    (event === "SessionStart" && body.source === "compact");

  if (event === "PreCompact") {
    // Enter "compacting" only from an actively-working state (allowlist). A
    // /compact at rest (idle/stopped/ready) or before any state exists
    // (unknown) has no live turn to interrupt, and a duplicate PreCompact while
    // already "compacting" must not overwrite the saved baseline with the
    // spinner state itself — all of these are no-ops here, so nothing strands.
    if (COMPACT_ENTER_FROM.has(prev.status)) {
      agentStates.set(sessionId, {
        ...prev,
        ...CLEAR_TOOL,
        status: "compacting",
        preCompactStatus: prev.status,
        lastEvent: event,
        updatedAt: timestamp,
      });
    }
  } else if (isCompactResolve) {
    // Idempotent "compaction resolved" signal. SessionStart(source=compact)
    // and PostCompact both land here; whichever arrives first restores the
    // baseline and clears it, so the second is a no-op — order can't strand us.
    // Act only while a compaction is in flight: mid-window ("compacting"), a
    // saved baseline awaiting restore, or a cold "unknown" store (resume auto-
    // compact — restoredStatus() maps its missing baseline to "ready", so there
    // is no spurious "compacting" flash). Any other state is already resolved.
    const compactionInFlight =
      prev.status === "compacting" ||
      prev.status === "unknown" ||
      prev.preCompactStatus !== undefined;
    if (compactionInFlight) {
      agentStates.set(sessionId, {
        ...prev,
        ...CLEAR_TOOL,
        status: restoredStatus(prev.preCompactStatus),
        preCompactStatus: undefined,
        lastEvent: event,
        updatedAt: timestamp,
      });
    }
    // else: already resolved by the sibling signal → no-op.
  } else if (
    prev.status === "compacting" &&
    (event === "SubagentStart" || event === "SubagentStop")
  ) {
    // The compaction summarizer runs as a subagent; its Start/Stop fire inside
    // the compaction window. Ignore them so the spinner stays stable until a
    // resolve signal — otherwise it flickers to orchestrating/working.
  } else {
    // Generic path — derive status + sticky-idle guard (unchanged behavior).
    const statusUpdate = deriveStatus(body);
    if (statusUpdate.status) {
      // Guard: idle and stopped are "sticky" states — only specific events
      // can transition out. Late-arriving PostToolUse etc. are dropped.
      const isSticky = prev.status === "idle" || prev.status === "stopped";
      if (isSticky && !IDLE_EXIT_EVENTS.has(event)) {
        // Drop the transition — the agent is done with this turn.
      } else {
        if (
          statusUpdate.status === "needs_input" ||
          statusUpdate.status === "error"
        ) {
          console.log(
            `[hooks] ${sessionId.slice(0, 8)} ${prev.status} → ${statusUpdate.status}` +
              ` (event=${event}, notification_type=${body.notification_type ?? "none"})`,
          );
        }
        agentStates.set(sessionId, {
          ...prev,
          ...statusUpdate,
          // Any non-compaction status change ends the compaction interlude —
          // clear the baseline so it can't leak into a later cycle.
          preCompactStatus: undefined,
          lastEvent: event,
          updatedAt: timestamp,
        });
      }
    }
  }

  // Store notification-worthy events
  if (NOTIFY_EVENTS.has(event)) {
    appendNotification(sessionId, {
      event,
      message: typeof body.message === "string" ? body.message : undefined,
      timestamp,
      read: false,
    });
  }

  // Intercept SendUserMessage from --brief mode (PreToolUse only to avoid
  // duplicate notifications — PostToolUse carries the same payload)
  if (
    event === "PreToolUse" &&
    (body.tool_name === "SendUserMessage" || body.tool_name === "Brief")
  ) {
    const msg = body.tool_input?.message;
    if (typeof msg === "string" && msg.length > 0) {
      appendNotification(sessionId, {
        event: "SendUserMessage",
        message: msg,
        timestamp,
        read: false,
        proactive: body.tool_input?.status === "proactive" || undefined,
      });

      if (body.tool_input?.status === "proactive") {
        console.log(
          `[hooks] ${sessionId.slice(0, 8)} proactive: ${msg.slice(0, 80)}`,
        );
      }
    } else {
      console.warn(
        `[hooks] ${sessionId.slice(0, 8)} SendUserMessage with missing/empty message` +
          ` (keys: ${body.tool_input ? Object.keys(body.tool_input).join(",") : "none"})`,
      );
    }
  }

  return c.json({ ok: true, event, sessionId });
});

// ── Read surface (public listener, token-gated) ──────────────────────

export const hooksReadRouter = new Hono();

// Get agent status for a session
hooksReadRouter.get("/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json(getAgentState(sessionId));
});

// Bulk notifications across all sessions (for notification panel)
hooksReadRouter.get("/notifications", (c) => {
  const allAgents = listAgents();
  const sessionNames = new Map(allAgents.map((a) => [a.id, a.name]));

  const all: Array<
    SessionNotification & { sessionId: string; sessionName: string }
  > = [];
  let totalUnread = 0;

  for (const [sessionId, items] of notifications) {
    const name = sessionNames.get(sessionId) ?? sessionId.slice(0, 8);
    for (const n of items) {
      // Show SendUserMessage (actual agent messages from --brief) and
      // SystemWarning (server-originated alerts, e.g. prompt re-delivery).
      // Other events (Stop, Notification, PermissionRequest) are system noise.
      if (n.event !== "SendUserMessage" && n.event !== "SystemWarning")
        continue;
      all.push({ ...n, sessionId, sessionName: name });
      if (!n.read) totalUnread++;
    }
  }

  // Newest first
  all.sort((a, b) => b.timestamp - a.timestamp);

  return c.json({ notifications: all.slice(0, 100), totalUnread });
});

// Get notifications for a session
hooksReadRouter.get("/:sessionId/notifications", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json({
    notifications: getNotifications(sessionId),
    unread: getUnreadCount(sessionId),
  });
});

// Mark all notifications as read for a session
hooksReadRouter.post("/:sessionId/read", (c) => {
  const sessionId = c.req.param("sessionId");
  markRead(sessionId);
  return c.json({ ok: true });
});

// Bulk status for all sessions (efficient single call from sidebar)
hooksReadRouter.get("/", (c) => {
  const result: Record<string, { status: AgentState; unread: number }> = {};
  for (const [id, state] of agentStates) {
    result[id] = { status: state, unread: getUnreadCount(id) };
  }
  return c.json(result);
});
