// `autonomos upgrade` — fetch latest release, verify, atomic swap, restart daemon.
//
// Works whether the daemon is running or stopped:
//   - If a daemon is running, we read its PID file, perform the swap, then
//     SIGTERM the daemon (the supervisor restarts it with the new bundle).
//   - If no daemon is running, we just swap; user starts the new bundle when ready.
//
// Exit codes:
//   0  upgrade succeeded, or already up-to-date
//   1  failure (network, checksum, filesystem)
//   2  cannot run from a dev checkout (wrong layout)

import { isPidAlive, readPidFile } from "@autonomos/server/pid-file.js";
import {
  deriveBundleDir,
  detectPlatform,
  performUpgrade,
} from "@autonomos/server/upgrade.js";
import { getServerVersion } from "@autonomos/server/version.js";

export async function runUpgradeCommand(): Promise<number> {
  let bundleDir: string;
  try {
    bundleDir = deriveBundleDir();
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : err,
      "\n(autonomos upgrade is only supported on installed binaries, not dev checkouts.)",
    );
    return 2;
  }

  const platform = detectPlatform();
  const currentVersion = getServerVersion();
  console.log(`Current version: ${currentVersion}`);
  console.log("Checking for updates...");

  const result = await performUpgrade({
    bundleDir,
    currentVersion,
    platform,
  });

  if (result.status === "up-to-date") {
    console.log(`✓ Already on the latest version (${result.version}).`);
    return 0;
  }
  if (result.status === "upgraded") {
    console.log(`✓ Upgraded ${result.from} → ${result.to}.`);
    // Restart the running daemon if one is present. The supervisor brings
    // it back automatically; without a supervisor the user starts it.
    const pidInfo = readPidFile();
    if (pidInfo && isPidAlive(pidInfo.pid)) {
      console.log(`Restarting running daemon (pid ${pidInfo.pid}) to apply...`);
      try {
        process.kill(pidInfo.pid, "SIGTERM");
        console.log(
          "  (Supervisor will restart with the new bundle automatically.)",
        );
      } catch (err) {
        console.warn(
          `  Could not signal daemon: ${err instanceof Error ? err.message : err}`,
        );
        console.warn("  Restart it manually: autonomos stop && autonomos start");
      }
    } else {
      console.log(
        "No daemon running. Start the new version with `autonomos start`",
      );
    }
    return 0;
  }
  // result.status === "error"
  console.error(`✗ Upgrade failed: ${result.message}`);
  return 1;
}
