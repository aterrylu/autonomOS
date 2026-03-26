import { Hono } from "hono";

/**
 * Hook events received from Claude Code sessions via autonomos-relay.sh.
 * Tracks agent status (working, idle, needs input) and notifications.
 */

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string };
  notification_type?: string;
  source?: string;
  [key: string]: unknown;
}

export interface SessionNotification {
  event: string;
  message?: string;
  timestamp: number;
  read: boolean;
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

// ── Agent status helpers ─────────────────────────────────────────────

export function getAgentState(sessionId: string): AgentState {
  return agentStates.get(sessionId) ?? DEFAULT_AGENT_STATE;
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
      return { status: "working", ...CLEAR_TOOL };

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

// Receive hook events from Claude Code sessions
hooksRouter.post("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  let body: HookEvent;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const event = body.hook_event_name ?? "unknown";
  const timestamp = Date.now();

  // Update agent status
  const statusUpdate = deriveStatus(body);
  if (statusUpdate.status) {
    const prev = getAgentState(sessionId);
    // Log transitions to warning-producing statuses for debugging
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
      lastEvent: event,
      updatedAt: timestamp,
    });
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

  return c.json({ ok: true, event, sessionId });
});

// Get agent status for a session
hooksRouter.get("/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json(getAgentState(sessionId));
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
