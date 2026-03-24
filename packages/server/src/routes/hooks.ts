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
  return (
    agentStates.get(sessionId) ?? {
      status: "unknown",
      lastEvent: "",
      updatedAt: 0,
    }
  );
}

/** Derive agent status from a hook event */
function deriveStatus(event: HookEvent): Partial<AgentState> {
  const name = event.hook_event_name;

  switch (name) {
    case "SessionStart":
      return event.source === "compact"
        ? { status: "compacting" }
        : { status: "ready" };

    case "UserPromptSubmit":
      return {
        status: "working",
        currentTool: undefined,
        toolDetail: undefined,
      };

    case "PreToolUse":
      return {
        status: "tool_running",
        currentTool: event.tool_name,
        toolDetail: extractToolDetail(event),
      };

    case "PostToolUse":
      return {
        status: "working",
        currentTool: undefined,
        toolDetail: undefined,
      };

    case "PostToolUseFailure":
      return {
        status: "error",
        currentTool: event.tool_name,
        toolDetail: extractToolDetail(event),
      };

    case "Stop":
      return { status: "idle", currentTool: undefined, toolDetail: undefined };

    case "Notification":
      return event.notification_type === "permission_prompt"
        ? { status: "needs_input" }
        : { status: "idle" };

    case "PermissionRequest":
      return { status: "needs_input" };

    case "SubagentStart":
      return { status: "orchestrating" };

    case "PreCompact":
      return { status: "compacting" };

    case "SessionEnd":
      return {
        status: "stopped",
        currentTool: undefined,
        toolDetail: undefined,
      };

    default:
      return {};
  }
}

/** Extract a short detail string from tool input */
function extractToolDetail(event: HookEvent): string | undefined {
  if (!event.tool_input) return undefined;
  if (event.tool_input.file_path) {
    // Show just the filename
    const parts = event.tool_input.file_path.split("/");
    return parts[parts.length - 1];
  }
  if (event.tool_input.command) {
    // Truncate long commands
    const cmd = event.tool_input.command;
    return cmd.length > 40 ? `${cmd.slice(0, 37)}...` : cmd;
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
    const current = agentStates.get(sessionId);
    agentStates.set(sessionId, {
      ...current,
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
