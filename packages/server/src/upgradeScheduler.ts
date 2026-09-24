// "Update when agents are idle" (ADR-103).
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

import type { AgentActivityStatus } from "@autonomos/core";
import { listAgents } from "./agents/store.js";
import { getAgentState } from "./routes/hooks.js";
import { type LaunchResult, launchUpgradeJob } from "./upgradeJob.js";

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
};

export function listBusyAgents(): BusyAgent[] {
  const out: BusyAgent[] = [];
  for (const a of listAgents()) {
    if (a.status !== "running") continue;
    const s = getAgentState(a.id).status;
    if (BUSY_STATUSES.has(s)) out.push({ id: a.id, name: a.name, status: s });
  }
  return out;
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
  now?: () => number;
};
const DEFAULT_DEPS: Required<Deps> = {
  busy: listBusyAgents,
  launch: (t) => launchUpgradeJob(t),
  now: () => Date.now(),
};
let deps: Required<Deps> = { ...DEFAULT_DEPS };

/** One scheduler step. Exported for tests (drive time explicitly). */
export function tickArmedUpgrade(): LaunchResult | null {
  if (!armed) return null;
  const now = deps.now();
  if (deps.busy().length > 0) {
    armed.idleSince = null;
    return null;
  }
  if (armed.idleSince === null) {
    armed.idleSince = new Date(now).toISOString();
    return null;
  }
  if (now - Date.parse(armed.idleSince) < IDLE_WINDOW_MS) return null;
  const target = armed.target;
  disarmUpgrade();
  return deps.launch(target);
}

export function armUpgrade(target: string): ArmedState {
  armed = {
    target,
    armedAt: new Date(deps.now()).toISOString(),
    idleSince: null,
  };
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
  deps = { ...DEFAULT_DEPS };
}
