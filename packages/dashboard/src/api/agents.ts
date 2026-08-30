/** Agents family — `/api/agents/*`. */

import type { Agent, AgentTreeNode, HandoffQueueItem } from "@autonomos/core";
import { request } from "./core";

export interface SpawnAgentBody {
  workingDirectory: string;
  name?: string;
  prompt?: string;
  resumeAgentId?: string;
  resumeSessionId?: string;
  forkFromAgentId?: string;
  permissionMode?: string;
  appendSystemPrompt?: string;
  template?: string;
  manager?: string;
  project?: string;
  provider?: string;
  envPreset?: string;
  cols?: number;
  rows?: number;
}

export const agentsApi = {
  list: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<Agent[]>("/api/agents", opts),
  tree: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<AgentTreeNode[]>("/api/agents/tree", opts),
  spawn: (body: SpawnAgentBody) =>
    request<Agent>("/api/agents", { method: "POST", body }),
  attach: (id: string) =>
    request<Agent>(`/api/agents/${id}/attach`, { method: "POST", body: {} }),
  /** Reparent in the org chart. `manager` (name) or `managerId` (uuid); a null
   *  `managerId` clears. `POST /api/agents/:id/manager`. */
  manager: (
    id: string,
    body: { manager?: string; managerId?: string | null; version?: number },
  ) => request<Agent>(`/api/agents/${id}/manager`, { method: "POST", body }),
  kill: (id: string, reason?: string) =>
    request<{ ok: boolean; id: string }>(`/api/agents/${id}/kill`, {
      method: "POST",
      body: reason ? { reason } : {},
    }),
  remove: (
    id: string,
    opts?: { reassignTo?: string | null; force?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (opts?.force) params.set("force", "true");
    if (opts?.reassignTo !== undefined)
      params.set("reassignTo", String(opts.reassignTo));
    const qs = params.toString();
    return request<{ ok: boolean; id: string }>(
      `/api/agents/${id}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" },
    );
  },
  /** `failures` is per-agent, not a list of ids — the route returns
   * `restartAllAttachments()`'s `Array<{ id, name, error }>` verbatim
   * (server `agents/runtime.ts`), and the settings panel names the agents that
   * didn't come back. */
  restartAll: () =>
    request<{
      idMap?: Record<string, string>;
      failures?: Array<{ id: string; name: string; error: string }>;
    }>("/api/agents/restart-all", { method: "POST", body: {} }),

  // ── Hand-off queue (manual-queue agents, e.g. Gemini) — PR #355 server ──
  /** List an agent's queued hand-off messages, oldest first. */
  queueList: (id: string, opts?: { signal?: AbortSignal }) =>
    request<{ items: HandoffQueueItem[] }>(`/api/agents/${id}/queue`, opts),
  /** Deliver ONE queued message (PTY injection; leaves the queue on its hook
   *  receipt). 409 `{error}` if an injection is already in flight or no PTY. */
  queueSend: (id: string, itemId: string) =>
    request<{ ok: true }>(
      `/api/agents/${id}/queue/${encodeURIComponent(itemId)}/send`,
      { method: "POST", body: {} },
    ),
  /** Deliver ALL queued messages, one at a time (each gated on its receipt). */
  queueSendAll: (id: string) =>
    request<{ ok: true; remaining: number }>(
      `/api/agents/${id}/queue/send-all`,
      { method: "POST", body: {} },
    ),
  /** Discard ONE queued message (no delivery). 404 `{error}` if it's gone. */
  queueDiscard: (id: string, itemId: string) =>
    request<{ ok: true; removed: HandoffQueueItem }>(
      `/api/agents/${id}/queue/${encodeURIComponent(itemId)}`,
      { method: "DELETE" },
    ),
};
