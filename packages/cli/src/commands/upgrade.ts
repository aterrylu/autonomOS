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
import { getServerVersion } from "@autonomos/server/version.js";
import {
  expectedVersionAfterSwap,
  restartDaemonAfterSwap,
  syncSupervisorUnit,
} from "../lib/apply-bundle.js";

type UpgradeFlags = { targetVersion: string | undefined };

function parseFlags(argv: readonly string[]): UpgradeFlags {
  let targetVersion: string | undefined;
  for (const a of argv) {
    if (a.startsWith("--version=")) {
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
  return { targetVersion };
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

  const result = await performSourceUpgrade({
    repoRoot,
    installInfo: install.info,
    currentVersion,
    targetVersion: flags.targetVersion,
  });

  if (result.status === "up-to-date") {
    console.log(`✓ Already on the latest version (${result.version}).`);
    // Still self-heal unit-template drift — an install can be current on
    // code but running under an install-day unit. No restart follows here.
    syncSupervisorUnit({ restartFollows: false });
    return 0;
  }
  if (result.status === "error") {
    console.error(`✗ Upgrade failed: ${result.message}`);
    return 1;
  }

  if (result.direction === "downgrade") {
    console.log(`⚠️  DOWNGRADED ${result.from} → ${result.to} (as requested).`);
  } else {
    console.log(`✓ Upgraded ${result.from} → ${result.to}.`);
  }
  console.log("  Roll back anytime with: autonomos rollback");

  // Unit sync happens between swap and restart so the single existing
  // restart applies any drift heal — zero extra restarts either way. Sync
  // never alters programArgs, so if the health gate below fails, rollback's
  // previousRef checkout restores code at the very path the (possibly
  // freshly-healed) unit points at.
  const { reloadUnit } = syncSupervisorUnit({ restartFollows: true });
  const outcome = await restartDaemonAfterSwap(result.to, undefined, {
    reloadUnit,
  });
  if (outcome.kind === "restart-failed") {
    // Same verdict semantics as the bundle flow below: a failed supervisor
    // COMMAND says nothing about the just-built checkout — don't undo it.
    console.error(
      `✗ Upgrade is built and checked out, but the supervisor restart could ` +
        `not be issued. Not rolling back. Fix the supervisor, then run: ` +
        `autonomos restart (or undo with: autonomos rollback)`,
    );
    return 1;
  }
  if (outcome.kind !== "not-verified") return 0;

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
    console.error(`✗ Automatic rollback also failed: ${rollback.message}`);
    return 1;
  }
  const recovery = await restartDaemonAfterSwap(rollback.to);
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
  let flags: UpgradeFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 64;
  }

  let install: ResolvedInstall;
  try {
    install = resolveInstall();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  if (install.info.mode === "source") {
    return await runSourceUpgradeFlow(install, flags);
  }

  const overrides = resolveReleaseOverrides();
  if ("error" in overrides) {
    console.error(`✗ ${overrides.error}`);
    return 1;
  }

  const platform = detectPlatform();
  const currentVersion = getServerVersion();
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
  });

  if (result.status === "up-to-date") {
    console.log(`✓ Already on the latest version (${result.version}).`);
    // Same self-heal as the source flow: current code, install-day unit.
    syncSupervisorUnit({ restartFollows: false });
    return 0;
  }
  if (result.status === "error") {
    console.error(`✗ Upgrade failed: ${result.message}`);
    return 1;
  }

  if (result.direction === "downgrade") {
    console.log(`⚠️  DOWNGRADED ${result.from} → ${result.to} (as requested).`);
  } else {
    console.log(`✓ Upgraded ${result.from} → ${result.to}.`);
  }
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
    { reloadUnit },
  );
  if (outcome.kind === "restart-failed") {
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
  if (outcome.kind !== "not-verified") return 0;

  // Supervised restart didn't produce a healthy daemon on the new version.
  // Leaving the box down on a bad release is the one unacceptable outcome —
  // swap back and restart again.
  console.error(
    `✗ Version ${result.to} did not become healthy. Rolling back to ${result.from}...`,
  );
  const rollback = performRollback(install.bundleDir);
  if (rollback.status === "error") {
    console.error(`✗ Automatic rollback also failed: ${rollback.message}`);
    console.error(
      `  Manual recovery: mv ${install.bundleDir}.previous ${install.bundleDir}, then autonomos restart`,
    );
    return 1;
  }
  const recovery = await restartDaemonAfterSwap(rollback.to);
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
