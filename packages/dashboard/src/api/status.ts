/** Agent-status + notifications read surface (renamed from /api/hooks in PR C). */

import type { AgentStatusMap, NotificationFeed } from "@autonomos/core";
import { request } from "./core";

export const statusApi = {
  /** Bulk statuses + unread counts (`GET /api/agent-status`). */
  map: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<AgentStatusMap>("/api/agent-status", opts),
  /** Bulk notification feed (`GET /api/notifications`). */
  feed: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<NotificationFeed>("/api/notifications", opts),
  /** Mark one session's notifications read. */
  markRead: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/notifications/${sessionId}/read`, {
      method: "POST",
      body: {},
    }),
};
