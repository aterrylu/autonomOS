// "Update when agents are idle" (ADR-105).
//
// An update restarts the daemon, which closes every agent's PTY; agents come
// back via resume (ADR-049), but a turn in flight stops where it is and does
// not continue on its own, and a pending question is dismissed. So the
// default in-app path waits: armed with a target, it launches only once no
// agent has been busy for IDLE_WINDOW_MS continuously (Terry: 30s). Any new
// turn resets the window. "Busy" is ONE predicate shared with the dashboard's
// pre-flight list (served by the same endpoint), so what the operator is
// shown is exactly what the scheduler waits on.
//
// Armed state is in-memory: a daemon restart for any other reason drops it,
// which is the safe direction (the operator re-arms; nothing updates behind
// their back after a crash).

import { renameSync, writeFileSync } from "node:fs";
import type { AgentActivityStatus } from "@autonomos/core";
import { isPromptPending } from "./agents/promptDelivery.js";
import { getAgentProcessRoots } from "./agents/runtime.js";
import { listAgents } from "./agents/store.js";
import {
  type BackgroundProc,
  findBackgroundProcs,
  listProcesses,
} from "./backgroundProcs.js";
import { getAgentState } from "./routes/hooks.js";
import { type LaunchResult, launchUpgradeJob } from "./upgradeJob.js";
import {
  type FleetReport,
  upgradeFleetPath,
  upgradeJobRunning,
} from "./upgradeStatus.js";

export const IDLE_WINDOW_MS = 30_000;
const TICK_MS = 2_000;

/** Activity states that mean "an update now would interrupt something". */
export const BUSY_STATUSES: ReadonlySet<AgentActivityStatus> = new Set([
  "working",
  "tool_running",
  "needs_input",
  "compacting",
  "orchestrating",
]);

export type BusyAgent = {
  id: string;
  name: string;
  status: AgentActivityStatus;
  /** "first_task": just spawned with a prompt that hasn't started yet. Its
   *  status still reads unknown/ready, but a restart now would lose the task
   *  (the argv prompt isn't re-sent on resume). */
  reason?: "first_task";
};

/** A just-started agent whose status is still unknown is treated as busy for
 *  this long — the fallback for providers with no prompt-delivery receipt
 *  (Codex): ADR-074 measured argv prompts taking >40s to submit under load. */
export const FIRST_TASK_GRACE_MS = 90_000;

/** Why an agent would be interrupted by a restart now; null = it wouldn't.
 *  Pure — the inputs are read by listBusyAgents. */
export function busyReason(
  status: AgentActivityStatus,
  promptPending: boolean,
  startedAt: number | undefined,
  nowWall: number,
): "status" | "first_task" | null {
  if (BUSY_STATUSES.has(status)) return "status";
  if (promptPending) return "first_task";
  if (
    status === "unknown" &&
    typeof startedAt === "number" &&
    nowWall - startedAt < FIRST_TASK_GRACE_MS
  ) {
    return "first_task";
  }
  return null;
}

export function listBusyAgents(nowWall = Date.now()): BusyAgent[] {
  const out: BusyAgent[] = [];
  for (const a of listAgents()) {
    if (a.status !== "running") continue;
    const s = getAgentState(a.id).status;
    const why = busyReason(s, isPromptPending(a.id), a.startedAt, nowWall);
    if (why === "status") out.push({ id: a.id, name: a.name, status: s });
    else if (why === "first_task") {
      out.push({ id: a.id, name: a.name, status: s, reason: "first_task" });
    }
  }
  return out;
}

export type BackgroundWork = {
  id: string;
  name: string;
  processes: BackgroundProc[];
};

const BACKGROUND_CACHE_MS = 2_000;
let backgroundCache: { at: number; value: BackgroundWork[] } | null = null;

/**
 * Running agents with background shell work an update restart would stop —
 * a WARNING for the pre-flight, never a gate (status stays the only "busy").
 * One `ps` per call, cached briefly: the dialog polls every ~2s.
 */
export function listBackgroundWork(now = Date.now()): BackgroundWork[] {
  if (backgroundCache && now - backgroundCache.at < BACKGROUND_CACHE_MS) {
    return backgroundCache.value;
  }
  const running = listAgents().filter((a) => a.status === "running");
  const value: BackgroundWork[] = [];
  if (running.length > 0) {
    const table = listProcesses();
    for (const a of running) {
      const processes = findBackgroundProcs(table, getAgentProcessRoots(a.id));
      if (processes.length > 0)
        value.push({ id: a.id, name: a.name, processes });
    }
  }
  backgroundCache = { at: now, value };
  return value;
}

export type ArmedState = {
  target: string;
  armedAt: string;
  /** When the fleet was last observed fully idle continuously since; null = busy now. */
  idleSince: string | null;
};

let armed: ArmedState | null = null;
let timer: NodeJS.Timeout | undefined;

export function getArmedUpgrade(): ArmedState | null {
  return armed;
}

type Deps = {
  busy?: () => BusyAgent[];
  launch?: (target: string) => LaunchResult;
  /** Monotonic ms — the idle window must not jump with the wall clock (NTP
   *  steps, suspend/resume). */
  now?: () => number;
  /** A job already running (in-app or `autonomos upgrade` from a shell). */
  inFlight?: () => boolean;
};
const DEFAULT_DEPS: Required<Deps> = {
  busy: () => listBusyAgents(),
  launch: (t) => launchUpgradeJob(t, { waitIdle: true }),
  now: () => performance.now(),
  inFlight: () => upgradeJobRunning(),
};
let deps: Required<Deps> = { ...DEFAULT_DEPS };
/** Monotonic start of the current idle stretch (armed.idleSince is its
 *  wall-clock rendering, for display only). */
let idleSinceMono: number | null = null;

/** One scheduler step. Exported for tests (drive time explicitly). */
export function tickArmedUpgrade(): LaunchResult | null {
  if (!armed) return null;
  const now = deps.now();
  if (deps.busy().length > 0) {
    armed.idleSince = null;
    idleSinceMono = null;
    return null;
  }
  if (idleSinceMono === null) {
    idleSinceMono = now;
    armed.idleSince = new Date().toISOString();
    return null;
  }
  if (now - idleSinceMono < IDLE_WINDOW_MS) return null;
  // Never a second job next to a running one (a shell `autonomos upgrade`,
  // a Restore): wait it out; the run that follows sees whether it's needed.
  if (deps.inFlight()) return null;
  const target = armed.target;
  disarmUpgrade();
  return deps.launch(target);
}

export function armUpgrade(target: string): ArmedState {
  armed = {
    target,
    armedAt: new Date().toISOString(),
    idleSince: null,
  };
  idleSinceMono = null;
  if (!timer) {
    timer = setInterval(() => {
      try {
        const r = tickArmedUpgrade();
        if (r && !r.ok)
          console.warn(`[upgrade] armed launch failed: ${r.message}`);
      } catch (err) {
        console.warn(
          `[upgrade] armed tick failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }, TICK_MS);
    timer.unref();
  }
  tickArmedUpgrade();
  return armed;
}

export function disarmUpgrade(): void {
  armed = null;
  idleSinceMono = null;
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export function _setSchedulerDepsForTesting(d: Deps): void {
  deps = { ...deps, ...d };
}
export function _resetSchedulerForTesting(): void {
  disarmUpgrade();
  fleetIdleSinceMono = null;
  deps = { ...DEFAULT_DEPS };
}

// ── fleet report for the running job ────────────────────────────────────────
//
// "Wait for idle" is judged at launch, but a bundle download takes seconds
// and a source build minutes — and the old daemon keeps taking turns until
// the restart. So while a job is in flight the daemon publishes the fleet's
// state to a file the job re-checks right before its irreversible step
// (cli lib/restart-gate.ts). Only the daemon knows agent status; the job
// deliberately holds no token to ask it over HTTP.

let fleetIdleSinceMono: number | null = null;
let fleetTimer: NodeJS.Timeout | undefined;

/** One report step. Exported for tests. */
export function writeFleetReport(
  path = upgradeFleetPath(),
  now = deps.now(),
): FleetReport | null {
  if (!deps.inFlight()) {
    fleetIdleSinceMono = null;
    return null;
  }
  const busy = deps.busy();
  if (busy.length > 0) fleetIdleSinceMono = null;
  else if (fleetIdleSinceMono === null) fleetIdleSinceMono = now;
  const report: FleetReport = {
    at: new Date().toISOString(),
    idleForMs: fleetIdleSinceMono === null ? null : now - fleetIdleSinceMono,
    busy,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report));
  renameSync(tmp, path);
  return report;
}

export function startFleetReporter(): void {
  if (fleetTimer) return;
  fleetTimer = setInterval(() => {
    try {
      writeFleetReport();
    } catch (err) {
      console.warn(
        `[upgrade] fleet report failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }, TICK_MS);
  fleetTimer.unref();
}
