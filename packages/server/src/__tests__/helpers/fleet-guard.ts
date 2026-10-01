/**
 * Guards for any test that spins up a FLEET (many agents/processes) on a dev
 * box that is also running the live fleet.
 *
 * A 50-agent load rig on Terry's 16-core Mac, next to the live fleet, pushed
 * the load average past 600 and froze his :3100 dashboard (2026-10-01). So a
 * fleet harness must (1) hold the machine-wide slot that full test runs share,
 * and (2) watch the box and abort itself before it hurts anyone. CI runners are
 * dedicated, so both are skipped there.
 */

import { availableParallelism, loadavg } from "node:os";

const DEFAULT_LOCK = "/tmp/autonomos-ci-gate.lock";

/** Throws unless this process runs inside the machine-wide slot taken by
 *  scripts/ci-gate-lock.sh (e.g. via `make load-test`). */
export function assertFleetSlot(
  env: NodeJS.ProcessEnv = process.env,
  how = "make load-test",
): void {
  if (env.CI) return;
  const lock = env.AUTONOMOS_CI_GATE_LOCK_PATH ?? DEFAULT_LOCK;
  if (env.AUTONOMOS_GATE_LOCK_HELD !== lock)
    throw new Error(
      `this fleet test must hold the machine-wide test slot; run it via \`${how}\` (scripts/ci-gate-lock.sh), not directly`,
    );
}

/** Default abort threshold: well past "busy", well before "frozen". */
export function defaultLoadLimit(cpus = availableParallelism()): number {
  return cpus * 2.5;
}

/**
 * Poll the 1-minute load average; past `limit`, call `onAbort` once and stop.
 * Returns a stop function. No-op (returns a no-op) under CI.
 */
export function startLoadWatchdog(opts: {
  onAbort: (load: number) => void;
  limit?: number;
  intervalMs?: number;
  read?: () => number;
  env?: NodeJS.ProcessEnv;
}): () => void {
  if ((opts.env ?? process.env).CI) return () => {};
  const limit = opts.limit ?? defaultLoadLimit();
  const read = opts.read ?? (() => loadavg()[0]);
  const timer = setInterval(() => {
    const load = read();
    if (load > limit) {
      clearInterval(timer);
      opts.onAbort(load);
    }
  }, opts.intervalMs ?? 2000);
  timer.unref();
  return () => clearInterval(timer);
}
