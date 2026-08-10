/** Schedules family — `/api/schedules/*` (incl. scheduler control at /status, /settings). */

import type { RunRecord, Schedule, SchedulerStatus } from "@autonomos/core";
import { request } from "./core";

export const schedulesApi = {
  list: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<Record<string, Schedule>>("/api/schedules", opts),
  update: (name: string, patch: Partial<Schedule>) =>
    request<{ ok: boolean; schedule: Schedule }>(
      `/api/schedules/${encodeURIComponent(name)}`,
      { method: "PUT", body: patch },
    ),
  remove: (name: string) =>
    request<{ ok: boolean; message: string }>(
      `/api/schedules/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  run: (name: string) =>
    request<{ ok: boolean; message: string }>(
      `/api/schedules/${encodeURIComponent(name)}/run`,
      { method: "POST", body: {} },
    ),
  runs: (name: string, limit = 20) =>
    request<RunRecord[]>(
      `/api/schedules/${encodeURIComponent(name)}/runs?limit=${limit}`,
    ),
  schedulerStatus: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<SchedulerStatus>("/api/schedules/status", opts),
  updateSchedulerSettings: (settings: { maxConcurrentRuns: number }) =>
    request<{ ok: boolean }>("/api/schedules/settings", {
      method: "PUT",
      body: settings,
    }),
};
