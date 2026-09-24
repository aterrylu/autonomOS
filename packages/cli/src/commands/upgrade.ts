// `autonomos upgrade` (alias: `update`) — fetch a release, verify, atomic
// swap, restart, health-gate, auto-rollback (ADR-077).
//
// Usage:
//   autonomos upgrade                 # upgrade to the latest release
//   autonomos upgrade --version=0.4.0 # pin (downgrades allowed, said loudly)
//   autonomos upgrade 0.4.0           # same, positional
//
// Install-shape resolution comes from install.json (installInfo.ts) — the
// recorded marker, never a path sniff. Bundle mode is handled here; source
// mode (a managed git clone) refuses with instructions until its backend
// ships. Unknown shapes refuse with instructions.
//
// After a successful swap on a SUPERVISED install, we verify the new version
// actually boots (pid-file version + HTTP probe). If it doesn't come up
// within the window, we automatically roll the swap back and restart again —
// a broken release must not leave the box down.
//
// Test hooks (used by scripts/test-install.sh's hermetic fixture server):
//   AUTONOMOS_RELEASE_API_URL   Override https://api.github.com
//   AUTONOMOS_RELEASE_REPO      Override the aterrylu/autonomOS repo slug
//
// Exit codes:
//   0  upgrade succeeded (verified where verifiable), or already up-to-date
//   1  failure (network, checksum, filesystem, or health-gate rollback)
//   2  unsupported install shape (source mode / dev checkout / unknown)

import {
  type ResolvedInstall,
  readInstallJson,
  resolveInstall,
} from "@autonomos/server/installInfo.js";
import {
  createSnapshot,
  deleteSnapshot,
  pruneSnapshots,
  SNAPSHOT_RETENTION,
  type SnapshotManifest,
} from "@autonomos/server/snapshots.js";
import {
  getVersionAt,
  performSourceRollback,
  performSourceUpgrade,
} from "@autonomos/server/sourceUpgrade.js";
import {
  detectPlatform,
  performRollback,
  performUpgrade,
  resolveReleaseOverrides,
} from "@autonomos/server/upgrade.js";
import { upgradeFleetPath } from "@autonomos/server/upgradeStatus.js";
import { getServerVersion } from "@autonomos/server/version.js";
import {
  expectedVersionAfterSwap,
  restartDaemonAfterSwap,
  syncSupervisorUnit,
} from "../lib/apply-bundle.js";
import { readFleetReport, waitForIdleFleet } from "../lib/restart-gate.js";
import { restoreStateFor } from "../lib/state-pair.js";
import {
  makeReporter,
  type Reporter,
  statusFileArg,
  withTerminalStatus,
  withUpgradeLock,
} from "../lib/status-report.js";

/**
 * Snapshot agent state BEFORE anything changes (ADR-105). Fail-safe: no
 * snapshot, no update — the safety net is not optional. Returns null after
 * reporting the failure.
 */
function takeSnapshot(
  from: string,
  to: string | undefined,
  report: Reporter,
): SnapshotManifest | null {
  report("snapshotting", { from });
  try {
    const snap = createSnapshot(from, to ?? null);
    report("snapshotting", { snapshotId: snap.id });
    console.log(
      `✓ Saved a snapshot of agent state (${Math.round(snap.bytes / 1024)} KB): snapshots/${snap.id}`,
    );
    return snap;
  } catch (err) {
    const message = `Couldn't save a snapshot of your agents' state, so nothing was changed: ${err instanceof Error ? err.message : err}`;
    report("failed", { message });
    console.error(`✗ ${message}`);
    return null;
  }
}

const IDLE_WINDOW_MS = 30_000;
/** Before the swap/checkout nothing has changed yet, so giving up is clean. */
const GATE_CAP_BEFORE_CHANGE_MS = 15 * 60_000;
/** After a source build the code on disk already moved; wait less, then go. */
const GATE_CAP_AFTER_BUILD_MS = 5 * 60_000;

async function idleGate(
  flags: UpgradeFlags,
  report: Reporter,
  capMs: number,
): Promise<{ ok: true } | { ok: false; names: string; minutes: number }> {
  if (!flags.waitIdle) return { ok: true };
  const r = await waitForIdleFleet({
    readFleet: () => readFleetReport(upgradeFleetPath()),
    windowMs: IDLE_WINDOW_MS,
    capMs,
    onWaiting: (busy) => {
      const names = busy.map((b) => b.name).join(", ");
      report("waiting_idle", {
        message: names
          ? `Waiting for ${names} to finish`
          : "Waiting for every agent to be idle for 30 seconds",
      });
      console.log(`… waiting for idle${names ? ` (${names})` : ""}`);
    },
  });
  if (r.ok) return { ok: true };
  return {
    ok: false,
    names: r.busy.map((b) => b.name).join(", ") || "agents",
    minutes: Math.round(capMs / 60_000),
  };
}

type UpgradeFlags = {
  targetVersion: string | undefined;
  /**
   * In-app update (ADR-105): the out-of-band job passes this so the
   * dashboard can follow progress across the restart. Absent for a shell
   * run — then every report below is a no-op.
   */
  statusFile: string | undefined;
  /** "Wait for idle" (ADR-105): re-check the fleet right before the
   *  irreversible step. Passed by the idle scheduler's launch. */
  waitIdle: boolean;
};

function parseFlags(argv: readonly string[]): UpgradeFlags {
  let targetVersion: string | undefined;
  let statusFile: string | undefined;
  let waitIdle = false;
  for (const a of argv) {
    if (a === "--wait-idle") {
      waitIdle = true;
    } else if (a.startsWith("--status-file=")) {
      statusFile = a.slice("--status-file=".length);
    } else if (a.startsWith("--version=")) {
      targetVersion = a.slice("--version=".length);
    } else if (/^v?\d+\.\d+\.\d+/.test(a)) {
      targetVersion = a;
    } else {
      throw new Error(
        `Unknown argument: ${a}\nUsage: autonomos upgrade [--version=X.Y.Z]`,
      );
    }
  }
  // Accept both "0.4.0" and "v0.4.0" — the release tag adds the v itself.
  if (targetVersion?.startsWith("v")) targetVersion = targetVersion.slice(1);
  return { targetVersion, statusFile, waitIdle };
}

/**
 * Source-mode (managed clone) upgrade: fetch tags → dirty-tree refusal →
 * checkout target tag → rebuild → supervisor restart + health gate →
 * auto-rollback (checkout previousRef + rebuild + restart) if the new
 * version doesn't come up. Same shape as the bundle flow below; git is the
 * version store instead of the .previous directory.
 */
async function runSourceUpgradeFlow(
  install: ResolvedInstall,
  flags: UpgradeFlags,
  report: Reporter,
): Promise<number> {
  // bundleDir is where resolveInstall PHYSICALLY found the marker — ground
  // truth. info.prefix is what the installer wrote at install time and goes
  // stale (relative path, moved clone); it is display metadata only.
  const repoRoot = install.bundleDir;
  const currentVersion = getVersionAt(repoRoot) ?? "unknown";
  console.log(
    `Current version: ${currentVersion} (managed clone: ${repoRoot})`,
  );
  console.log(
    flags.targetVersion
      ? `Fetching tag v${flags.targetVersion}...`
      : "Fetching release tags...",
  );

  // Taken at the last moment before anything changes (beforeCheckout), and
  // refreshed after the build — the daemon keeps writing records meanwhile.
  const snap: { current: SnapshotManifest | null } = { current: null };
  let touched = false;
  report("fetching", { from: currentVersion });
  const result = await performSourceUpgrade({
    repoRoot,
    installInfo: install.info,
    currentVersion,
    targetVersion: flags.targetVersion,
    onPhase: (p) => {
      touched = true; // "building" follows the checkout
      report(p);
    },
    beforeCheckout: async () => {
      const gate = await idleGate(flags, report, GATE_CAP_BEFORE_CHANGE_MS);
      if (!gate.ok) {
        return {
          proceed: false,
          message: `${gate.names} stayed busy for ${gate.minutes} minutes, so nothing was changed. Try again when they're idle, or choose Update now.`,
        };
      }
      snap.current = takeSnapshot(currentVersion, flags.targetVersion, report);
      return snap.current
        ? { proceed: true }
        : {
            proceed: false,
            message:
              "Couldn't save a snapshot of your agents' state, so nothing was changed.",
          };
    },
  });

  if (result.status === "up-to-date") {
    report("up_to_date");
    console.log(`✓ Already on the latest version (${result.version}).`);
    // Still self-heal unit-template drift — an install can be current on
    // code but running under an install-day unit. No restart follows here.
    syncSupervisorUnit({ restartFollows: false });
    return 0;
  }
  if (result.status === "error") {
    // Failed before the checkout: nothing on disk changed, so a snapshot
    // would only be a duplicate Restore row. Past it, keep it.
    const dropped = !touched && snap.current !== null;
    if (dropped && snap.current) deleteSnapshot(snap.current.id);
    report("failed", {
      message: result.message,
      ...((dropped || !snap.current) && { snapshotId: undefined }),
    });
    console.error(`✗ Upgrade failed: ${result.message}`);
    return 1;
  }
  if (!snap.current) {
    // Unreachable: the checkout only happens after beforeCheckout took it.
    throw new Error("updated without a state snapshot");
  }

  // The build took minutes and the old daemon kept taking turns: re-check
  // idle, then refresh the snapshot so it holds the state actually left.
  const gate2 = await idleGate(flags, report, GATE_CAP_AFTER_BUILD_MS);
  if (!gate2.ok) {
    console.warn(
      `⚠️  ${gate2.names} still busy after ${gate2.minutes} more minutes; restarting anyway (the new code is already built).`,
    );
  }
  try {
    const fresh = createSnapshot(currentVersion, result.to);
    deleteSnapshot(snap.current.id);
    snap.current = fresh;
    report("snapshotting", { snapshotId: fresh.id });
  } catch (err) {
    console.warn(
      `⚠️  Couldn't refresh the state snapshot (${err instanceof Error ? err.message : err}); keeping the one taken before the build.`,
    );
  }
  const snapshot = snap.current;

  // Something changed on disk: only now is this snapshot worth a retention
  // slot (pruning at creation evicted a real one per no-op or failed try).
  pruneSnapshots(undefined, SNAPSHOT_RETENTION, [snapshot.id]);

  if (result.direction === "downgrade") {
    console.log(`⚠️  DOWNGRADED ${result.from} → ${result.to} (as requested).`);
  } else {
    console.log(`✓ Upgraded ${result.from} → ${result.to}.`);
  }
  console.log("  Roll back anytime with: autonomos rollback");
  report("restarting", { to: result.to });

  // Unit sync happens between swap and restart so the single existing
  // restart applies any drift heal — zero extra restarts either way. Sync
  // never alters programArgs, so if the health gate below fails, rollback's
  // previousRef checkout restores code at the very path the (possibly
  // freshly-healed) unit points at.
  const { reloadUnit } = syncSupervisorUnit({ restartFollows: true });
  const outcome = await restartDaemonAfterSwap(result.to, undefined, {
    reloadUnit,
    onRestarted: () => report("health_check"),
  });
  if (outcome.kind === "restart-failed") {
    report("failed", {
      message:
        "The update installed but the service restart could not be issued — run `autonomos restart` (or undo with `autonomos rollback`).",
    });
    // Same verdict semantics as the bundle flow below: a failed supervisor
    // COMMAND says nothing about the just-built checkout — don't undo it.
    console.error(
      `✗ Upgrade is built and checked out, but the supervisor restart could ` +
        `not be issued. Not rolling back. Fix the supervisor, then run: ` +
        `autonomos restart (or undo with: autonomos rollback)`,
    );
    return 1;
  }
  if (outcome.kind !== "not-verified") {
    report("done", {
      message:
        outcome.kind === "verified"
          ? undefined
          : "Installed; no supervised daemon was restarted — start it with `autonomos start`.",
    });
    return 0;
  }

  console.error(
    `✗ Version ${result.to} did not become healthy. Rolling back to ${result.from}...`,
  );
  // performSourceUpgrade rewrote the marker on disk (previousRef now points
  // at the checkout that was serving) — re-read it rather than using the
  // pre-upgrade snapshot in `install.info`. If the re-read FAILS, refuse the
  // auto-rollback outright: the stale snapshot's previousRef is from the
  // prior cycle, so substituting it would check out a commit from two
  // generations back (or falsely claim no rollback state exists).
  const freshMarker = readInstallJson(repoRoot);
  if (!freshMarker) {
    report("failed", {
      message:
        "The new version didn't come up and install.json could not be re-read, so no automatic rollback ran — run `autonomos rollback` on the host.",
    });
    console.error(
      `✗ Cannot auto-rollback: install.json could not be re-read after the ` +
        `upgrade. Roll back manually once the marker is repaired:\n` +
        `  autonomos rollback   (or: git -C ${repoRoot} log to locate the ` +
        `pre-upgrade commit for v${result.from})`,
    );
    return 1;
  }
  const rollback = performSourceRollback(repoRoot, freshMarker);
  if (rollback.status === "error") {
    report("failed", {
      message: `The new version didn't come up AND the automatic rollback failed: ${rollback.message}. Run \`autonomos rollback\` on the host.`,
    });
    console.error(`✗ Automatic rollback also failed: ${rollback.message}`);
    return 1;
  }
  // Code is back; now the STATE that pairs with it (daemon stopped first).
  const state = await restoreStateFor(rollback.to, result.to, snapshot.id);
  console.error(
    state.restored
      ? `✓ Restored agent state from snapshots/${state.snapshot.id}.`
      : `⚠️  Agent state not restored: ${state.reason}.`,
  );
  const recovery = await restartDaemonAfterSwap(rollback.to);
  report("rolled_back", {
    message:
      recovery.kind === "verified"
        ? `v${result.to} didn't become healthy within the health check, so v${rollback.to}${state.restored ? " and your agents' pre-update state were" : " was"} restored and it is serving again.${state.restored ? "" : ` (Agent state not restored: ${state.reason}.)`}`
        : `v${result.to} didn't become healthy; v${rollback.to} was restored but could not be verified serving — check \`autonomos status\`.`,
  });
  if (recovery.kind === "verified") {
    console.error(
      `✓ Rolled back to ${rollback.to} and it is serving again. ` +
        "The failed upgrade's logs: autonomos logs",
    );
  } else {
    console.error(
      `⚠️  Rolled back to ${rollback.to} but could not verify it came up. ` +
        "Check: autonomos status / autonomos logs",
    );
  }
  return 1;
}

export async function runUpgradeCommand(
  argv: readonly string[] = [],
): Promise<number> {
  const statusFile = statusFileArg(argv);
  return withTerminalStatus(statusFile, { kind: "upgrade" }, () =>
    withUpgradeLock("upgrade", makeReporter(statusFile), () =>
      upgradeCommand(argv),
    ),
  );
}

async function upgradeCommand(argv: readonly string[]): Promise<number> {
  let flags: UpgradeFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 64;
  }
  const report = makeReporter(flags.statusFile);

  let install: ResolvedInstall;
  try {
    install = resolveInstall();
  } catch (err) {
    report("failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  if (install.info.mode === "source") {
    return await runSourceUpgradeFlow(install, flags, report);
  }

  const overrides = resolveReleaseOverrides();
  if ("error" in overrides) {
    report("failed", { message: overrides.error });
    console.error(`✗ ${overrides.error}`);
    return 1;
  }

  const platform = detectPlatform();
  const currentVersion = getServerVersion();
  // Taken at the last moment before the swap (beforeSwap), after the idle
  // re-check — it must hold the state actually being left.
  const snap: { current: SnapshotManifest | null } = { current: null };
  let touched = false;
  console.log(`Current version: ${currentVersion}`);
  console.log(
    flags.targetVersion
      ? `Fetching release v${flags.targetVersion}...`
      : "Checking for updates...",
  );

  const result = await performUpgrade({
    bundleDir: install.bundleDir,
    currentVersion,
    platform,
    installInfo: install.info,
    targetVersion: flags.targetVersion,
    releaseApiBase: overrides.releaseApiBase,
    releaseRepo: overrides.releaseRepo,
    onPhase: (p) => {
      if (p === "installing") touched = true;
      report(p);
    },
    beforeSwap: async () => {
      const gate = await idleGate(flags, report, GATE_CAP_BEFORE_CHANGE_MS);
      if (!gate.ok) {
        return {
          proceed: false,
          message: `${gate.names} stayed busy for ${gate.minutes} minutes, so nothing was changed. Try again when they're idle, or choose Update now.`,
        };
      }
      snap.current = takeSnapshot(currentVersion, flags.targetVersion, report);
      return snap.current
        ? { proceed: true }
        : {
            proceed: false,
            message:
              "Couldn't save a snapshot of your agents' state, so nothing was changed.",
          };
    },
  });

  if (result.status === "up-to-date") {
    report("up_to_date");
    console.log(`✓ Already on the latest version (${result.version}).`);
    // Same self-heal as the source flow: current code, install-day unit.
    syncSupervisorUnit({ restartFollows: false });
    return 0;
  }
  if (result.status === "error") {
    // Failed before the swap: nothing on disk changed, so a snapshot would
    // only be a duplicate Restore row. Past it, keep it.
    const dropped = !touched && snap.current !== null;
    if (dropped && snap.current) deleteSnapshot(snap.current.id);
    report("failed", {
      message: result.message,
      ...((dropped || !snap.current) && { snapshotId: undefined }),
    });
    console.error(`✗ Upgrade failed: ${result.message}`);
    return 1;
  }
  const snapshot = snap.current;
  if (!snapshot) {
    // Unreachable: the swap only happens after beforeSwap took it.
    throw new Error("updated without a state snapshot");
  }

  // Something changed on disk: only now is this snapshot worth a retention
  // slot (pruning at creation evicted a real one per no-op or failed try).
  pruneSnapshots(undefined, SNAPSHOT_RETENTION, [snapshot.id]);

  if (result.direction === "downgrade") {
    console.log(`⚠️  DOWNGRADED ${result.from} → ${result.to} (as requested).`);
  } else {
    console.log(`✓ Upgraded ${result.from} → ${result.to}.`);
  }
  report("restarting", { to: result.to });
  console.log(`  Previous version kept at: ${install.bundleDir}.previous`);
  console.log("  Roll back anytime with: autonomos rollback");

  // Between swap and restart, same as the source flow: the one restart that
  // already happens applies any healed unit; sync preserves the program path
  // so a health-gate rollback (in-place .previous swap) stays consistent
  // with whatever unit is now installed.
  const { reloadUnit } = syncSupervisorUnit({ restartFollows: true });
  const outcome = await restartDaemonAfterSwap(
    expectedVersionAfterSwap(install.bundleDir, result.to),
    undefined,
    { reloadUnit, onRestarted: () => report("health_check") },
  );
  if (outcome.kind === "restart-failed") {
    report("failed", {
      message:
        "The update installed but the service restart could not be issued — run `autonomos restart` (or undo with `autonomos rollback`).",
    });
    // The supervisor COMMAND failed — the bundle was never judged, and the
    // daemon is likely still serving the old version. Rolling back here
    // would act on evidence about the supervisor, not the bundle.
    console.error(
      `✗ Upgrade is on disk, but the supervisor restart could not be issued. ` +
        `Not rolling back. Fix the supervisor, then run: autonomos restart ` +
        `(or undo with: autonomos rollback)`,
    );
    return 1;
  }
  if (outcome.kind !== "not-verified") {
    report("done", {
      message:
        outcome.kind === "verified"
          ? undefined
          : "Installed; no supervised daemon was restarted — start it with `autonomos start`.",
    });
    return 0;
  }

  // Supervised restart didn't produce a healthy daemon on the new version.
  // Leaving the box down on a bad release is the one unacceptable outcome —
  // swap back and restart again.
  console.error(
    `✗ Version ${result.to} did not become healthy. Rolling back to ${result.from}...`,
  );
  const rollback = performRollback(install.bundleDir);
  if (rollback.status === "error") {
    report("failed", {
      message: `The new version didn't come up AND the automatic rollback failed: ${rollback.message}. Run \`autonomos rollback\` on the host.`,
    });
    console.error(`✗ Automatic rollback also failed: ${rollback.message}`);
    console.error(
      `  Manual recovery: mv ${install.bundleDir}.previous ${install.bundleDir}, then autonomos restart`,
    );
    return 1;
  }
  // Code is back; now the STATE that pairs with it (daemon stopped first).
  const state = await restoreStateFor(rollback.to, result.to, snapshot.id);
  console.error(
    state.restored
      ? `✓ Restored agent state from snapshots/${state.snapshot.id}.`
      : `⚠️  Agent state not restored: ${state.reason}.`,
  );
  const recovery = await restartDaemonAfterSwap(rollback.to);
  report("rolled_back", {
    message:
      recovery.kind === "verified"
        ? `v${result.to} didn't become healthy within the health check, so v${rollback.to}${state.restored ? " and your agents' pre-update state were" : " was"} restored and it is serving again.${state.restored ? "" : ` (Agent state not restored: ${state.reason}.)`}`
        : `v${result.to} didn't become healthy; v${rollback.to} was restored but could not be verified serving — check \`autonomos status\`.`,
  });
  if (recovery.kind === "verified") {
    console.error(
      `✓ Rolled back to ${rollback.to} and it is serving again. ` +
        "The failed upgrade's logs: autonomos logs",
    );
  } else {
    console.error(
      `⚠️  Rolled back to ${rollback.to} but could not verify it came up. ` +
        "Check: autonomos status / autonomos logs",
    );
  }
  return 1;
}
