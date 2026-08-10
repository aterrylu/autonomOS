/** Hooks read surface — agent activity statuses + the notification feed. */

import type { AgentStatusMap, NotificationFeed } from "@autonomos/core";
import { request } from "./core";

export const statusApi = {
  /** Bulk statuses + unread counts (`GET /api/hooks`). */
  map: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<AgentStatusMap>("/api/hooks", opts),
  /** Bulk notification feed (`GET /api/hooks/notifications`). */
  feed: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<NotificationFeed>("/api/hooks/notifications", opts),
  /** Mark one session's notifications read. */
  markRead: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/hooks/${sessionId}/read`, {
      method: "POST",
      body: {},
    }),
};
