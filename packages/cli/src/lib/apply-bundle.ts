// Post-swap restart + health gate, shared by `autonomos upgrade` and
// `autonomos rollback` (ADR-076).
//
// The swap itself is an atomic rename done by the caller. What happens next
// depends on who supervises the daemon:
//
//   - Installed service (launchd/systemd): we ask the SUPERVISOR to cycle it
//     (restartService). Safe here because this CLI runs out-of-process — the
//     in-process REST path must never do this (it stages and exits instead).
//     Then we gate on the pid file: the NEW server writes its version into
//     $configDir/autonomos.pid on listen, so "pid file shows the expected
//     version AND the port answers" is a real boot-success signal, not a
//     guess — and it needs no auth token.
//   - No service, daemon running: SIGTERM stops it and nothing brings it
//     back. Say exactly that — the old code claimed "supervisor will restart"
//     unconditionally, which was a lie for foreground daemons.
//   - Nothing running: nothing to restart; the next start picks up the swap.
//
// verifyDaemonVersion polls rather than sleeping: startup takes 2-10s
// normally, but a cold Node boot on a busy box can take longer.

import {
  isPidAlive,
  isPortResponsive,
  readPidFile,
} from "@autonomos/server/pid-file.js";
import { readBundleVersion } from "@autonomos/server/upgrade.js";
import { findInstalledService, restartService } from "./service-control.js";

/**
 * The version to health-gate on after a swap: what the swapped-in bundle
 * ACTUALLY carries (its package.json), falling back to the release tag only
 * when the bundle's version is unreadable. Gating on the tag directly would
 * make a release whose package.json disagrees with its tag fail the gate
 * every time — auto-rolling back a healthy daemon with a misleading
 * "did not become healthy".
 */
export function expectedVersionAfterSwap(
  bundleDir: string,
  tagVersion: string,
): string {
  const bundleVersion = readBundleVersion(bundleDir);
  return bundleVersion === "unknown" ? tagVersion : bundleVersion;
}

export type RestartOutcome =
  | { kind: "verified" } // supervisor cycled it; new version confirmed up
  | { kind: "not-verified" } // supervisor cycled it; gate timed out
  | { kind: "restart-failed" } // the supervisor COMMAND failed; bundle unjudged
  | { kind: "stopped-no-supervisor" } // daemon stopped; user must start it
  | { kind: "not-running" }; // no daemon; nothing restarted

/**
 * Restart the daemon after a bundle swap and (when supervised) verify the
 * expected version actually came up. Returns what happened — the CALLER
 * decides whether "not-verified" means roll back.
 *
 * "restart-failed" is deliberately distinct from "not-verified": a failed
 * `launchctl kickstart` / `systemctl restart` INVOCATION (no user bus over a
 * non-login ssh session, launchd permission error) says nothing about the
 * just-verified bundle — the daemon most likely never restarted and is still
 * serving the OLD version. Auto-rolling back on that verdict would swap
 * files based on evidence about the supervisor, not the bundle.
 */
export async function restartDaemonAfterSwap(
  expectedVersion: string,
  timeoutMs = 45_000,
): Promise<RestartOutcome> {
  const svc = findInstalledService();
  if (svc) {
    console.log("Restarting the installed service...");
    const result = restartService(svc);
    if (!result.ok) {
      console.warn(`  Supervisor restart failed: ${result.stderr.trim()}`);
      console.warn(
        "  The swapped-in version is on disk but was NOT judged — the daemon " +
          "is likely still running the previous version.",
      );
      console.warn("  Restart manually: autonomos restart");
      return { kind: "restart-failed" };
    }
    const healthy = await verifyDaemonVersion(expectedVersion, timeoutMs);
    return healthy ? { kind: "verified" } : { kind: "not-verified" };
  }

  const pidInfo = readPidFile();
  if (pidInfo && isPidAlive(pidInfo.pid)) {
    console.log(`Stopping running daemon (pid ${pidInfo.pid})...`);
    try {
      process.kill(pidInfo.pid, "SIGTERM");
      console.log(
        "  No supervisor is installed, so nothing restarts it automatically.",
      );
      console.log("  Start the new version with: autonomos start");
    } catch (err) {
      console.warn(
        `  Could not signal daemon: ${err instanceof Error ? err.message : err}`,
      );
      console.warn("  Restart it manually: autonomos stop && autonomos start");
    }
    return { kind: "stopped-no-supervisor" };
  }

  console.log("No daemon running. Start the new version with: autonomos start");
  return { kind: "not-running" };
}

// Progress output must never influence the verdict: a closed stdout pipe
// (`autonomos upgrade | head`) raises EPIPE on write, and if that reached the
// polling loop's catch it would read as "unhealthy" and roll back a healthy
// daemon. Cosmetics fail silently; only the actual probes decide.
function progress(text: string): void {
  try {
    process.stdout.write(text);
  } catch {
    // stdout gone — keep polling regardless.
  }
}

/**
 * Poll until the daemon's pid file reports `expectedVersion` and its port
 * answers HTTP. True = the new version is genuinely serving.
 */
export async function verifyDaemonVersion(
  expectedVersion: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  progress(`Waiting for version ${expectedVersion} to come up`);
  try {
    while (Date.now() < deadline) {
      const pidInfo = readPidFile();
      if (
        pidInfo &&
        pidInfo.version === expectedVersion &&
        isPidAlive(pidInfo.pid) &&
        (await isPortResponsive(pidInfo.port))
      ) {
        progress(" ✓\n");
        return true;
      }
      progress(".");
      await new Promise((r) => setTimeout(r, 1000));
    }
    progress(" ✗ (timed out)\n");
    return false;
  } catch {
    progress(" ✗\n");
    return false;
  }
}
