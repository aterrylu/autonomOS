/** Agents family — `/api/agents/*`. */

import type { Agent, AgentTreeNode } from "@autonomos/core";
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
  list: (opts?: { signal?: AbortSignal }) =>
    request<Agent[]>("/api/agents", opts),
  tree: (opts?: { signal?: AbortSignal }) =>
    request<AgentTreeNode[]>("/api/agents/tree", opts),
  spawn: (body: SpawnAgentBody) =>
    request<Agent>("/api/agents", { method: "POST", body }),
  attach: (id: string) =>
    request<Agent>(`/api/agents/${id}/attach`, { method: "POST", body: {} }),
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
};
