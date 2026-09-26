// Code + state move together (ADR-105 amendment).
//
// A rollback that restores CODE but not STATE runs old code on records a
// newer version may have rewritten. Every path that puts an older version
// back — the health gate's auto-rollback, `autonomos rollback`, the in-app
// Restore — therefore restores the snapshot taken when that version was
// left, as one pair.
//
// Ordering is load-bearing: the daemon must be STOPPED before state is
// restored (a running daemon keeps writing the very records being replaced);
// the caller's restartDaemonAfterSwap then brings it back (launchd: kickstart
// fails on the unloaded job and falls back to bootstrap; systemd: restart
// starts a stopped unit).

import { isPidAlive, readPidFile } from "@autonomos/server/pid-file.js";
import {
  restoreSnapshot,
  type SnapshotManifest,
  snapshotForVersion,
} from "@autonomos/server/snapshots.js";
import { findInstalledService, stopService } from "./service-control.js";

/** Stop the daemon and wait for it to be gone. Returns the pid that is
 *  still alive when it didn't stop — restoring under a live daemon would let
 *  it re-persist its in-memory records over the restored ones. */
async function stopDaemonForRestore(): Promise<number | null> {
  const svc = findInstalledService();
  if (svc) {
    // A failed stop is judged by the liveness wait below, not the exit code
    // (stopping an already-stopped unit also "fails").
    stopService(svc);
  } else {
    const pid = readPidFile();
    if (pid && isPidAlive(pid.pid)) {
      try {
        process.kill(pid.pid, "SIGTERM");
      } catch {
        // gone already
      }
    }
  }
  // Give the daemon a moment to finish its shutdown writes before we swap
  // state under it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pid = readPidFile();
    if (!pid || !isPidAlive(pid.pid)) return null;
    if (Date.now() >= deadline) return pid.pid;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export type StateRestoreResult =
  | { restored: true; snapshot: SnapshotManifest; saved: SnapshotManifest }
  | { restored: false; reason: string };

/**
 * Stop the daemon and restore the snapshot that pairs with `version` (the
 * newest one taken FROM it), or the explicit `snapshotId`. The live state —
 * written by `liveVersion` — is saved as its own snapshot first, so nothing
 * the newer version wrote is lost. With no matching snapshot (installs
 * updated before snapshots existed) the rollback is code-only and the caller
 * says so — never silently.
 */
export async function restoreStateFor(
  version: string,
  liveVersion: string,
  snapshotId?: string,
): Promise<StateRestoreResult> {
  const snap = snapshotId ? { id: snapshotId } : snapshotForVersion(version);
  if (!snap) {
    return {
      restored: false,
      reason: `no snapshot was taken when v${version} was left (it predates snapshots) — agent records are left as they are`,
    };
  }
  const alive = await stopDaemonForRestore();
  if (alive !== null) {
    return {
      restored: false,
      reason: `the daemon (pid ${alive}) didn't stop, so its state was not touched`,
    };
  }
  try {
    const { restored, saved } = restoreSnapshot(snap.id, liveVersion);
    return { restored: true, snapshot: restored, saved };
  } catch (err) {
    return {
      restored: false,
      reason: `the snapshot could not be restored: ${err instanceof Error ? err.message : err}`,
    };
  }
}
