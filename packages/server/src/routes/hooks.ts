import { Hono } from "hono";

/**
 * Hook events received from Claude Code sessions via autonomos-relay.sh.
 * Stores the latest notification per session for sidebar badges.
 */

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface SessionNotification {
  event: string;
  message?: string;
  timestamp: number;
  read: boolean;
}

// In-memory notification store — keyed by session ID
const notifications = new Map<string, SessionNotification[]>();

/** Events that generate a user-visible notification badge */
const NOTIFY_EVENTS = new Set([
  "Notification",
  "Stop",
  "PermissionRequest",
]);

export function getNotifications(
  sessionId: string,
): SessionNotification[] {
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

  // Store notification-worthy events
  if (NOTIFY_EVENTS.has(event)) {
    const items = notifications.get(sessionId) ?? [];
    items.push({
      event,
      message: typeof body.message === "string" ? body.message : undefined,
      timestamp,
      read: false,
    });
    // Keep only last 50 notifications per session
    if (items.length > 50) items.splice(0, items.length - 50);
    notifications.set(sessionId, items);
  }

  return c.json({ ok: true, event, sessionId });
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
