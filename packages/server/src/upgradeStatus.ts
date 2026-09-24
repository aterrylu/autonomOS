// Out-of-band upgrade progress record (ADR-103).
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

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";

export type UpgradePhase =
  | "launching" // daemon started the job; the job hasn't reported yet
  | "snapshotting" // copying agent state before anything changes
  | "fetching" // source: git fetch tags
  | "downloading" // bundle: tarball + SHA256SUMS
  | "verifying" // bundle: checksum
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
  const tmp = `${path}.tmp`;
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
