/**
 * The shared poll instances — one per resource, module-level so every
 * component subscribing to the same data shares one timer and one request.
 *
 * FOREGROUND INTERVALS ARE THE PRE-MIGRATION VALUES, byte-for-byte: keeping
 * the dashboard exactly as responsive while the user is looking is a hard
 * product constraint (Terry). What changes is only the hidden-tab behavior:
 * pure-display polls pause; the STATUS poll (which feeds `needs_input`
 * desktop notifications — the thing that matters most while away) throttles
 * to 15s instead.
 */

import type {
  Agent,
  AgentStatusMap,
  AgentTemplate,
  AgentTreeNode,
  EnvPreset,
  ProjectInfo,
  Schedule,
  SchedulerStatus,
} from "@autonomos/core";
import { agentsApi } from "./agents";
import { presetsApi, templatesApi } from "./config";
import { projectsApi } from "./misc";
import { createPoll } from "./poll";
import { schedulesApi } from "./schedules";
import { statusApi } from "./status";

/** 3s foreground (status icons + desktop notifications), 15s hidden. */
export const statusPoll = createPoll<AgentStatusMap>({
  source: () => statusApi.map(),
  intervalMs: 3000,
  hiddenIntervalMs: 15_000,
});

/** 5s — the sidebar agent list. Retired outright by the push migration. */
export const agentsPoll = createPoll<Agent[]>({
  source: () => agentsApi.list(),
  intervalMs: 5000,
});

/** 5s — ONE shared tree poll (replaces the Sidebar + HierarchyPanel twins,
 * which each ran their own 5s timer with different cache policies). */
export const treePoll = createPoll<AgentTreeNode[]>({
  source: () => agentsApi.tree(),
  intervalMs: 5000,
});

/** 30s — the 86KB payload; subscribed only while the Projects UI is in use. */
export const projectsPoll = createPoll<ProjectInfo[]>({
  source: () => projectsApi.list(),
  intervalMs: 30_000,
});

/** 10s — schedules + scheduler status in one poll (was 2 requests/tick from
 * the panel; still 2 requests but one shared cycle + snapshot). */
export const schedulesPoll = createPoll<{
  schedules: Record<string, Schedule>;
  scheduler: SchedulerStatus | null;
}>({
  source: async () => {
    const [schedules, scheduler] = await Promise.all([
      schedulesApi.list(),
      schedulesApi.schedulerStatus().catch(() => null),
    ]);
    return { schedules, scheduler };
  },
  intervalMs: 10_000,
});

/** 10s each — config panels. */
export const templatesPoll = createPoll<AgentTemplate[]>({
  source: () => templatesApi.list(),
  intervalMs: 10_000,
});
export const presetsPoll = createPoll<EnvPreset[]>({
  source: () => presetsApi.list(),
  intervalMs: 10_000,
});
