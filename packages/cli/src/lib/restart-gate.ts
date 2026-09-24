// "Wait for idle", re-checked at the last responsible moment (ADR-105).
//
// The daemon's idle scheduler launches the job once the fleet has been idle
// for 30s — but the job then downloads (seconds) or fetches + builds (minutes)
// while the old daemon keeps taking turns. Idle at launch is not idle at the
// restart. So a "wait for idle" job calls this right before its irreversible
// step and waits, bounded, until the daemon's fleet report
// (upgradeScheduler.writeFleetReport) shows the same 30s of continuous idle.
//
// A report that is missing or stale means the daemon isn't publishing — it is
// down (then no agent is running to interrupt) or predates the report. Either
// way there is nothing to wait for, and the gate passes.

import { readFileSync } from "node:fs";
import type {
  FleetBusyAgent as BusyAgent,
  FleetReport,
} from "@autonomos/server/upgradeStatus.js";

export const FLEET_STALE_MS = 10_000;

export type GateResult =
  | { ok: true; waitedMs: number }
  | { ok: false; waitedMs: number; busy: BusyAgent[] };

export function readFleetReport(path: string): FleetReport | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8"));
    return typeof v?.at === "string" ? (v as FleetReport) : null;
  } catch {
    return null;
  }
}

export async function waitForIdleFleet(opts: {
  readFleet: () => FleetReport | null;
  windowMs: number;
  capMs: number;
  /** Called while waiting (throttled): report the busy agents. */
  onWaiting: (busy: BusyAgent[]) => void;
  heartbeatMs?: number;
  pollMs?: number;
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<GateResult> {
  const now = opts.now ?? (() => performance.now());
  const wallNow = opts.wallNow ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 1_000;
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const start = now();
  let lastBeat = Number.NEGATIVE_INFINITY;
  for (;;) {
    const f = opts.readFleet();
    const fresh = f !== null && wallNow() - Date.parse(f.at) < FLEET_STALE_MS;
    if (!fresh) return { ok: true, waitedMs: now() - start };
    if (f.idleForMs !== null && f.idleForMs >= opts.windowMs) {
      return { ok: true, waitedMs: now() - start };
    }
    const waited = now() - start;
    if (waited >= opts.capMs) {
      return { ok: false, waitedMs: waited, busy: f.busy };
    }
    if (now() - lastBeat >= heartbeatMs) {
      opts.onWaiting(f.busy);
      lastBeat = now();
    }
    await sleep(pollMs);
  }
}
