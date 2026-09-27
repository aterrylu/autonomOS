// Out-of-band upgrade progress record (ADR-105).
//
// The in-app update is executed by a SEPARATE supervisor job (upgradeJob.ts),
// because the daemon cannot be the agent of its own restart (ADR-077). That
// job's progress therefore cannot flow through the daemon it is about to
// kill: it is written here, to $configDir/upgrade-status.json, by the
// `autonomos upgrade --status-file` process. While the daemon is up it serves
// this file to the dashboard; across the restart gap the dashboard polls
// /api/system/version until the target answers, then reads the final record.
//
// Writes are atomic (temp + rename) — a reader must never see a torn JSON
// half-way through a phase change, least of all the one written seconds
// before a SIGKILL-adjacent restart.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";

export type UpgradePhase =
  | "launching" // daemon started the job; the job hasn't reported yet
  | "snapshotting" // copying agent state before anything changes
  | "fetching" // source: git fetch tags
  | "downloading" // bundle: tarball + SHA256SUMS
  | "verifying" // bundle: checksum
  | "waiting_idle" // "wait for idle": re-checking the fleet before the irreversible step
  | "installing" // bundle: atomic swap
  | "building" // source: checkout + make build (minutes)
  | "restarting" // supervisor restart issued — the daemon is down now
  | "health_check" // waiting for the new version to answer
  | "done" // new version verified serving
  | "rolled_back" // health gate failed; previous version restored
  | "failed" // nothing changed OR rollback itself failed — see message
  | "up_to_date"; // nothing to do

export type UpgradeStatusRecord = {
  phase: UpgradePhase;
  from: string;
  to: string | null;
  /** Human-readable detail for failed / rolled_back; optional otherwise. */
  message?: string;
  startedAt: string;
  updatedAt: string;
  /** "upgrade" (default) or "rollback" — the in-app Restore runs the same job shape. */
  kind?: "upgrade" | "rollback";
  /** The pre-upgrade state snapshot this run took (snapshots.ts). */
  snapshotId?: string;
  /** Written by the NEW daemon after "done" (upgradeVerify.ts). */
  verification?: UpgradeVerification;
  /** Launched by "wait for idle": the job re-checks the fleet before its
   *  irreversible step (shows as its own step in the dashboard). */
  waitIdle?: boolean;
};

export type UpgradeVerification = {
  checkedAt: string;
  /** Agents from the snapshot baseline that were checked. */
  checked: number;
  problems: { id: string; name: string; issue: string }[];
};

export const TERMINAL_PHASES: ReadonlySet<UpgradePhase> = new Set([
  "done",
  "rolled_back",
  "failed",
  "up_to_date",
]);

/** A non-terminal record older than this is a job that died without a final
 *  write, not a live run (a long source build can take minutes per phase). */
export const IN_FLIGHT_STALE_MS = 15 * 60 * 1000;
/** The job writes "snapshotting" within seconds of starting; a record still
 *  at "launching" after this means the job never started at all. */
export const LAUNCH_STALE_MS = 2 * 60 * 1000;

export function isUpgradeInFlight(
  rec: UpgradeStatusRecord | null,
  now = Date.now(),
): boolean {
  if (!rec || TERMINAL_PHASES.has(rec.phase)) return false;
  const age = now - Date.parse(rec.updatedAt);
  if (!Number.isFinite(age)) return false;
  return (
    age < (rec.phase === "launching" ? LAUNCH_STALE_MS : IN_FLIGHT_STALE_MS)
  );
}

export function upgradeStatusPath(configDir = getConfigDir()): string {
  return join(configDir, "upgrade-status.json");
}

export function readUpgradeStatus(
  path = upgradeStatusPath(),
): UpgradeStatusRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed.phase === "string") {
      return parsed as UpgradeStatusRecord;
    }
    return null;
  } catch {
    return null; // absent or unreadable = no upgrade on record
  }
}

export function writeUpgradeStatus(
  record: UpgradeStatusRecord,
  path = upgradeStatusPath(),
): void {
  // Unique per writer: the job and the daemon (verification) both write this
  // file, and a shared temp name lets one rename the other's half-written
  // temp into place — a torn record reads as "no upgrade", i.e. not in flight.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Convenience for a phase transition on an existing record. */
export function advanceUpgradeStatus(
  path: string,
  patch: Partial<UpgradeStatusRecord> & { phase: UpgradePhase },
): void {
  const prev = readUpgradeStatus(path);
  const now = new Date().toISOString();
  writeUpgradeStatus(
    {
      from: prev?.from ?? "unknown",
      to: prev?.to ?? null,
      startedAt: prev?.startedAt ?? now,
      ...prev,
      ...patch,
      updatedAt: now,
    },
    path,
  );
}

// ── one job at a time, across processes ─────────────────────────────────────
//
// The status file says what the IN-APP job is doing, but a shell
// `autonomos upgrade` or `rollback` writes no status file — and two jobs
// extracting into the same `.new` dir, or checking out the same clone, corrupt
// each other. Every upgrade/rollback run (in-app job or shell) holds this
// O_EXCL lock; the routes and the idle tick honor it. A lock whose pid is dead
// is stale and taken over.

export type UpgradeLock = {
  pid: number;
  verb: string;
  startedAt: string;
  /** The holder's process start identity: with pid reuse (after a reboot,
   *  or just time), a live pid alone says nothing about WHICH process. */
  pidStart?: string;
};

/** Backstop for a lock whose holder identity can't be checked: no update or
 *  restore job lives anywhere near this long. */
export const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** A process's start identity, or null when it can't be read. */
export function processStartId(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Fields after the ")" of comm (which may itself contain spaces);
      // starttime is field 22 overall = index 19 after the ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return rest[19] ?? null;
    }
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2_000,
    });
    const out = r.stdout?.trim();
    return r.status === 0 && out ? out : null;
  } catch {
    return null;
  }
}

export function upgradeLockPath(configDir = getConfigDir()): string {
  return join(configDir, "upgrade.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): UpgradeLock | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8"));
    return typeof v?.pid === "number" ? (v as UpgradeLock) : null;
  } catch {
    return null;
  }
}

/** Is the lock's holder the SAME process that took it, still alive? */
function holderLive(
  holder: UpgradeLock,
  isAlive: (pid: number) => boolean,
  startId: (pid: number) => string | null,
  now: number,
): boolean {
  if (!isAlive(holder.pid)) return false;
  if (holder.pidStart) {
    const current = startId(holder.pid);
    // Unreadable now → fall through to the age bound, never wedge.
    if (current !== null) return current === holder.pidStart;
  }
  const age = now - Date.parse(holder.startedAt);
  return Number.isFinite(age) && age < LOCK_MAX_AGE_MS;
}

export function upgradeLockHeld(
  path = upgradeLockPath(),
  isAlive: (pid: number) => boolean = pidAlive,
  startId: (pid: number) => string | null = processStartId,
  now = Date.now(),
): boolean {
  const holder = readLock(path);
  return holder !== null && holderLive(holder, isAlive, startId, now);
}

export function acquireUpgradeLock(
  verb: string,
  path = upgradeLockPath(),
  isAlive: (pid: number) => boolean = pidAlive,
  startId: (pid: number) => string | null = processStartId,
): { ok: true; release: () => void } | { ok: false; holder: UpgradeLock } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const pidStart = startId(process.pid);
      const lock: UpgradeLock = {
        pid: process.pid,
        verb,
        startedAt: new Date().toISOString(),
        ...(pidStart && { pidStart }),
      };
      writeSync(fd, JSON.stringify(lock));
      closeSync(fd);
      return {
        ok: true,
        release: () => {
          if (readLock(path)?.pid === process.pid) {
            try {
              unlinkSync(path);
            } catch {
              // already gone
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(path);
      if (holder && holderLive(holder, isAlive, startId, Date.now())) {
        return { ok: false, holder };
      }
      // Stale (holder died, or its pid now belongs to another process) or
      // unreadable (died mid-write): take it over.
      try {
        unlinkSync(path);
      } catch {
        // raced with another taker — the retry decides
      }
    }
  }
  const holder = readLock(path);
  return {
    ok: false,
    holder: holder ?? { pid: -1, verb: "unknown", startedAt: "" },
  };
}

// ── fleet report (daemon → job) ─────────────────────────────────────────────
// Written by the daemon while a job is in flight (upgradeScheduler), read by
// the job's last-moment idle gate (cli lib/restart-gate.ts). Lives here so the
// CLI can import the contract without pulling in the agent runtime.

export type FleetBusyAgent = {
  id: string;
  name: string;
  status: string;
  reason?: "first_task";
};

export type FleetReport = {
  at: string;
  /** Continuous idle so far, ms (monotonic); null = something is busy now. */
  idleForMs: number | null;
  busy: FleetBusyAgent[];
};

export function upgradeFleetPath(configDir = getConfigDir()): string {
  return join(configDir, "upgrade-fleet.json");
}

/**
 * Is an update/restore job actually running? The lock is the authority: every
 * job holds it from its first step to its last write, so a record past
 * "launching" with no live lock holder is an orphan (the job was killed) —
 * say so NOW instead of after the 15-minute staleness bound. Only the short
 * gap between the daemon writing "launching" and the job taking the lock
 * still leans on the time bound.
 */
export function upgradeJobRunning(
  rec: UpgradeStatusRecord | null = readUpgradeStatus(),
  lockHeld: boolean = upgradeLockHeld(),
  now = Date.now(),
): boolean {
  if (lockHeld) return true;
  return (
    rec !== null && rec.phase === "launching" && isUpgradeInFlight(rec, now)
  );
}
