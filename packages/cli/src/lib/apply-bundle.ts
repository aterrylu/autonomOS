// Post-swap restart + health gate, shared by `autonomos upgrade` and
// `autonomos rollback` (ADR-077).
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
import {
  findInstalledService,
  restartService,
  restartServiceReloading,
} from "./service-control.js";
import { syncServiceUnitFor } from "./service-sync.js";

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

/**
 * Sync the installed supervisor unit to the current template before the
 * post-swap restart. Idempotent in the strict sense: byte-identical render →
 * nothing written, no supervisor command issued, nothing printed. Only on
 * genuine template drift is the file re-rendered (around the PRESERVED
 * install-time program path, --port/--host, and env — never regenerated),
 * and the returned flag tells the caller to use a plist-re-reading restart
 * (macOS kickstart never re-reads the file; see restartServiceReloading).
 *
 * `restartFollows: false` (the already-up-to-date paths) still self-heals
 * drift but must be honest about when it takes effect: on macOS a rewritten
 * plist is only re-read on bootstrap, so we SAY that instead of forcing a
 * daemon bounce for a unit-file heal — a no-op upgrade must not restart
 * anything (Terry's ruling, ADR pending).
 *
 * A sync failure never blocks the upgrade — the daemon keeps running under
 * the existing unit, which was good enough yesterday.
 */
export function syncSupervisorUnit(opts: { restartFollows: boolean }): {
  reloadUnit: boolean;
} {
  const svc = findInstalledService();
  if (!svc) return { reloadUnit: false };
  const outcome = syncServiceUnitFor(svc);
  switch (outcome.kind) {
    case "in-sync":
      return { reloadUnit: false };
    case "updated": {
      console.log(
        "✓ Supervisor unit re-rendered to the current template " +
          "(install-time program path, port/host, and environment preserved).",
      );
      if (outcome.reloadWarning) {
        console.warn(
          `  ⚠️  systemd daemon-reload failed: ${outcome.reloadWarning}\n` +
            "  The updated unit applies at the next daemon-reload or reboot.",
        );
      }
      if (!opts.restartFollows && svc.platform === "darwin") {
        console.log(
          "  It takes effect at the next full service reload " +
            "(autonomos stop && autonomos restart) or reboot — not forcing " +
            "a restart for a unit-file change alone.",
        );
      }
      return { reloadUnit: true };
    }
    case "skipped":
      console.warn(
        `⚠️  Supervisor unit not synced: ${outcome.reason}.\n` +
          "  Continuing the upgrade under the existing unit. Re-render " +
          "manually with: autonomos install-service --force (keep any " +
          "--port/--host baked into the current file).",
      );
      return { reloadUnit: false };
  }
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
  opts: {
    /**
     * True when syncSupervisorUnit just rewrote the unit file: restart via
     * bootout+bootstrap so launchd re-reads the plist (kickstart would
     * restart the stale loaded definition). No-op difference on Linux.
     */
    reloadUnit?: boolean;
  } = {},
): Promise<RestartOutcome> {
  const svc = findInstalledService();
  if (svc) {
    console.log("Restarting the installed service...");
    const result = opts.reloadUnit
      ? restartServiceReloading(svc)
      : restartService(svc);
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
