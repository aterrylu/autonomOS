import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
import { recordEvent } from "../memory/events.js";
import { getProvider } from "../providers/index.js";

/**
 * Hook events received from Claude Code sessions via autonomos-relay.sh.
 * Tracks agent status (working, idle, needs input) and notifications.
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
  /** Status saved when entering "compacting" so PostCompact can restore it.
   *  Cleared on PostCompact. Undefined when no meaningful baseline exists
   *  (e.g., cold-start + auto-compact on session resume). */
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

/** Events that generate a user-visible notification badge */
const NOTIFY_EVENTS = new Set(["Notification", "Stop", "PermissionRequest"]);

/** Hook events captured as `notification`-type memory entries — coarse
 *  agent-state signals. NOTIFY_EVENTS plus SubagentStart. */
const MEMORY_NOTIFICATION_EVENTS = new Set([
  "Stop",
  "Notification",
  "PermissionRequest",
  "SubagentStart",
]);

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

// ── Agent status helpers ─────────────────────────────────────────────

export function getAgentState(sessionId: string): AgentState {
  return agentStates.get(sessionId) ?? DEFAULT_AGENT_STATE;
}

export function clearAgentState(sessionId: string): void {
  agentStates.delete(sessionId);
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
      return event.source === "compact"
        ? { status: "compacting" }
        : { status: "ready" };

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

    case "PreCompact":
      return { status: "compacting" };

    case "PostCompact":
      // Handler restores the saved preCompactStatus when present. This
      // "ready" is the safe fallback when we have no baseline — e.g.,
      // auto-compact on session resume, where the in-memory state was
      // empty before compaction started. "working" would leave the UI
      // stuck spinning since no subsequent Stop event fires in that case.
      return { status: "ready", ...CLEAR_TOOL };

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

// ── Router ───────────────────────────────────────────────────────────

export const hooksRouter = new Hono();

// Receive hook events from agent sessions (any provider).
// Providers may emit native event names (e.g. Gemini's "BeforeTool") — the
// provider's optional normalizeEvent() translates them to CC-shaped vocabulary
// before deriveStatus consumes them. CC has no translator (identity).
hooksRouter.post("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
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

  // Update agent status
  const statusUpdate = deriveStatus(body);
  if (statusUpdate.status) {
    const prev = getAgentState(sessionId);

    // Guard: idle and stopped are "sticky" states — only specific events
    // can transition out. Late-arriving PostToolUse etc. are dropped.
    const isSticky = prev.status === "idle" || prev.status === "stopped";
    if (isSticky && !IDLE_EXIT_EVENTS.has(event)) {
      // Drop the transition — the agent is done with this turn
    } else {
      // Compact transitions: save prev status on entering "compacting" so
      // PostCompact can restore it. Without this, a session that auto-
      // compacts on resume (no active turn) would get stuck at "working".
      // Invariant: preCompactStatus is only set while status === "compacting".
      let nextStatus = statusUpdate.status;
      let nextPreCompact: AgentStatus | undefined = prev.preCompactStatus;

      const enteringCompacting =
        statusUpdate.status === "compacting" &&
        prev.status !== "compacting" &&
        prev.status !== "unknown";
      if (enteringCompacting) {
        nextPreCompact = prev.status;
      } else if (event === "PostCompact" && prev.preCompactStatus) {
        // These statuses reflect transient conditions (in-flight tool,
        // permission prompt, error) that don't survive the JSONL collapse
        // — coerce to "working" so the agent continues its turn cleanly.
        const stalePreCompact = new Set<AgentStatus>([
          "tool_running",
          "needs_input",
          "error",
        ]);
        nextStatus = stalePreCompact.has(prev.preCompactStatus)
          ? "working"
          : prev.preCompactStatus;
        nextPreCompact = undefined;
      } else if (nextStatus !== "compacting") {
        // Exiting compacting via any other path (SessionEnd, duplicate
        // PostCompact, etc.) — clear the stale baseline.
        nextPreCompact = undefined;
      }

      if (nextStatus === "needs_input" || nextStatus === "error") {
        console.log(
          `[hooks] ${sessionId.slice(0, 8)} ${prev.status} → ${nextStatus}` +
            ` (event=${event}, notification_type=${body.notification_type ?? "none"})`,
        );
      }
      agentStates.set(sessionId, {
        ...prev,
        ...statusUpdate,
        // currentTool/toolDetail are always stale after compaction —
        // clear explicitly so the invariant doesn't depend on deriveStatus
        // continuing to include CLEAR_TOOL for PostCompact.
        ...(event === "PostCompact" ? CLEAR_TOOL : {}),
        status: nextStatus,
        preCompactStatus: nextPreCompact,
        lastEvent: event,
        updatedAt: timestamp,
      });
    }
  }

  // Store notification-worthy events
  if (NOTIFY_EVENTS.has(event)) {
    const items = notifications.get(sessionId) ?? [];
    items.push({
      event,
      message: typeof body.message === "string" ? body.message : undefined,
      timestamp,
      read: false,
    });
    if (items.length > 50) items.splice(0, items.length - 50);
    notifications.set(sessionId, items);
  }

  // Intercept SendUserMessage from --brief mode (PreToolUse only to avoid
  // duplicate notifications — PostToolUse carries the same payload)
  if (
    event === "PreToolUse" &&
    (body.tool_name === "SendUserMessage" || body.tool_name === "Brief")
  ) {
    const msg = body.tool_input?.message;
    if (typeof msg === "string" && msg.length > 0) {
      const items = notifications.get(sessionId) ?? [];
      items.push({
        event: "SendUserMessage",
        message: msg,
        timestamp,
        read: false,
        proactive: body.tool_input?.status === "proactive" || undefined,
      });
      if (items.length > 50) items.splice(0, items.length - 50);
      notifications.set(sessionId, items);

      if (body.tool_input?.status === "proactive") {
        console.log(
          `[hooks] ${sessionId.slice(0, 8)} proactive: ${msg.slice(0, 80)}`,
        );
      }

      recordEvent({
        type: "brief",
        actorAgentId: sessionId,
        summary: `brief from ${agent?.name ?? sessionId.slice(0, 8)}: ${msg}`,
        payload: {
          message: msg,
          proactive: body.tool_input?.status === "proactive" || false,
        },
      });
    } else {
      console.warn(
        `[hooks] ${sessionId.slice(0, 8)} SendUserMessage with missing/empty message` +
          ` (keys: ${body.tool_input ? Object.keys(body.tool_input).join(",") : "none"})`,
      );
    }
  }

  if (event === "UserPromptSubmit") {
    const prompt =
      typeof body.prompt === "string"
        ? body.prompt
        : typeof rawBody.prompt === "string"
          ? rawBody.prompt
          : "";
    recordEvent({
      type: "prompt_received",
      actorAgentId: sessionId,
      summary: prompt
        ? `prompt: ${prompt}`
        : `prompt_received by ${agent?.name ?? sessionId.slice(0, 8)}`,
      payload: prompt ? { prompt } : undefined,
    });
  } else if (MEMORY_NOTIFICATION_EVENTS.has(event)) {
    recordEvent({
      type: "notification",
      actorAgentId: sessionId,
      summary: `${event}${
        body.notification_type ? ` (${body.notification_type})` : ""
      } — ${agent?.name ?? sessionId.slice(0, 8)}`,
      payload: {
        hookEvent: event,
        notificationType: body.notification_type,
      },
    });
  }

  return c.json({ ok: true, event, sessionId });
});

// Get agent status for a session
hooksRouter.get("/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json(getAgentState(sessionId));
});

// Bulk notifications across all sessions (for notification panel)
hooksRouter.get("/notifications", (c) => {
  const allAgents = listAgents();
  const sessionNames = new Map(allAgents.map((a) => [a.id, a.name]));

  const all: Array<
    SessionNotification & { sessionId: string; sessionName: string }
  > = [];
  let totalUnread = 0;

  for (const [sessionId, items] of notifications) {
    const name = sessionNames.get(sessionId) ?? sessionId.slice(0, 8);
    for (const n of items) {
      // Only show SendUserMessage events — these are actual agent messages from --brief.
      // Other events (Stop, Notification, PermissionRequest) are system noise.
      if (n.event !== "SendUserMessage") continue;
      all.push({ ...n, sessionId, sessionName: name });
      if (!n.read) totalUnread++;
    }
  }

  // Newest first
  all.sort((a, b) => b.timestamp - a.timestamp);

  return c.json({ notifications: all.slice(0, 100), totalUnread });
});

// Get notifications for a session
hooksRouter.get("/:sessionId/notifications", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json({
    notifications: getNotifications(sessionId),
    unread: getUnreadCount(sessionId),
  });
});

// Mark all notifications as read for a session
hooksRouter.post("/:sessionId/read", (c) => {
  const sessionId = c.req.param("sessionId");
  markRead(sessionId);
  return c.json({ ok: true });
});

// Bulk status for all sessions (efficient single call from sidebar)
hooksRouter.get("/", (c) => {
  const result: Record<string, { status: AgentState; unread: number }> = {};
  for (const [id, state] of agentStates) {
    result[id] = { status: state, unread: getUnreadCount(id) };
  }
  return c.json(result);
});
