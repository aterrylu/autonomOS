// `autonomos upgrade` (alias: `update`) — fetch a release, verify, atomic
// swap, restart, health-gate, auto-rollback (ADR-075).
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
  resolveInstall,
} from "@autonomos/server/installInfo.js";
import {
  detectPlatform,
  performRollback,
  performUpgrade,
} from "@autonomos/server/upgrade.js";
import { getServerVersion } from "@autonomos/server/version.js";
import {
  expectedVersionAfterSwap,
  restartDaemonAfterSwap,
} from "../lib/apply-bundle.js";

type UpgradeFlags = { targetVersion: string | undefined };

type ReleaseOverrides =
  | { releaseApiBase: string | undefined; releaseRepo: string | undefined }
  | { error: string };

/**
 * The release-source env overrides exist for the hermetic test harness, but
 * they are production-reachable — and whoever controls the API base controls
 * BOTH the tarball and its SHA256SUMS, so the checksum cannot protect
 * against a redirected source (nothing is signed). A var planted in a shell
 * rc converts the user's own later `autonomos upgrade` into running
 * attacker code. So: warn loudly whenever one is set, and refuse a
 * non-HTTPS base unless it points at loopback (the fixture case).
 */
function resolveReleaseOverrides(): ReleaseOverrides {
  const releaseApiBase = process.env.AUTONOMOS_RELEASE_API_URL;
  const releaseRepo = process.env.AUTONOMOS_RELEASE_REPO;
  if (releaseApiBase || releaseRepo) {
    console.warn("⚠️  Release source is overridden by environment variables:");
    if (releaseApiBase) {
      console.warn(`   AUTONOMOS_RELEASE_API_URL=${releaseApiBase}`);
    }
    if (releaseRepo) {
      console.warn(`   AUTONOMOS_RELEASE_REPO=${releaseRepo}`);
    }
    console.warn("   (unset these unless you set them yourself, on purpose)");
  }
  if (releaseApiBase) {
    let url: URL;
    try {
      url = new URL(releaseApiBase);
    } catch {
      return {
        error: `AUTONOMOS_RELEASE_API_URL is not a valid URL: ${releaseApiBase}`,
      };
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname,
    );
    if (url.protocol !== "https:" && !loopback) {
      return {
        error:
          `AUTONOMOS_RELEASE_API_URL must be https:// (or loopback, for the ` +
          `test harness): ${releaseApiBase}`,
      };
    }
  }
  return { releaseApiBase, releaseRepo };
}

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
    console.error(
      "This is a source (git clone) install. The source-mode upgrade backend\n" +
        "ships in an upcoming release; until then update with:\n" +
        "  git pull && make prod",
    );
    return 2;
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

  const outcome = await restartDaemonAfterSwap(
    expectedVersionAfterSwap(install.bundleDir, result.to),
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
