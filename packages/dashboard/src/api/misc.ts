/** Small families — host, providers, projects, usage. */

import type {
  HostInfo,
  ProjectInfo,
  ProviderInfo,
  UsageQueueSnapshot,
} from "@autonomos/core";
import { request } from "./core";

export const hostApi = {
  get: (opts?: { signal?: AbortSignal }) =>
    request<HostInfo>("/api/host", opts),
};

export const providersApi = {
  list: (opts?: { signal?: AbortSignal }) =>
    request<ProviderInfo[]>("/api/providers", opts),
};

export const projectsApi = {
  list: (opts?: { signal?: AbortSignal }) =>
    request<ProjectInfo[]>("/api/projects", opts),
};

export const usageQueueApi = {
  snapshot: (opts?: { signal?: AbortSignal }) =>
    request<UsageQueueSnapshot>("/api/usage-queue", opts),
  arm: (sessionId: string) =>
    request<{ armed: boolean; provider: string }>(
      `/api/usage-queue/${sessionId}`,
      { method: "POST", body: {} },
    ),
  disarm: (sessionId: string) =>
    request<{ armed: boolean }>(`/api/usage-queue/${sessionId}`, {
      method: "DELETE",
    }),
};
