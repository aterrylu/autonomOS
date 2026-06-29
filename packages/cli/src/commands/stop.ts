// `autonomos stop` — shut down the running daemon.
//
// If an OS-native service is installed, stop it through the supervisor —
// launchd KeepAlive / systemd Restart would immediately revive a bare SIGTERM,
// so we must tell the supervisor (see lib/service-control.ts). Otherwise (a
// foreground / bundled daemon) fall back to SIGTERM-the-pid, escalating to
// SIGKILL after a grace period.
//
// Exit codes:
//   0 — daemon successfully stopped (or wasn't running to begin with)
//   1 — failed to stop

import {
  isPidAlive,
  readPidFile,
  removePidFile,
} from "@autonomos/server/pid-file.js";
import { findInstalledService, stopService } from "../lib/service-control.js";

const GRACEFUL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

export async function runStopCommand(): Promise<number> {
  // Supervised daemon: stopping the process isn't enough — KeepAlive/Restart
  // would revive it. Stop it at the supervisor instead.
  const svc = findInstalledService();
  if (svc) {
    const res = stopService(svc);
    if (!res.ok) {
      console.error(
        `Failed to stop the service: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      );
      return 1;
    }
    console.log(
      svc.platform === "darwin"
        ? "✓ Stopped the autonomos service (launchctl bootout)"
        : "✓ Stopped the autonomos service (systemctl --user stop)",
    );
    console.log("  Start it again with `autonomos restart` or `make prod`.");
    return 0;
  }

  const pidInfo = readPidFile();

  if (pidInfo === null) {
    console.log("autonomOS daemon: not running");
    return 0;
  }

  if (!isPidAlive(pidInfo.pid)) {
    console.log("autonomOS daemon: not running (stale PID file removed)");
    removePidFile();
    return 0;
  }

  console.log(`Sending SIGTERM to pid ${pidInfo.pid}...`);
  try {
    process.kill(pidInfo.pid, "SIGTERM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to send SIGTERM: ${msg}`);
    return 1;
  }

  // Wait for graceful shutdown
  const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(pidInfo.pid)) {
      console.log("✓ Daemon stopped cleanly");
      // The daemon should clean up its PID file on shutdown, but if it
      // crashed mid-shutdown the file may linger — remove it defensively.
      removePidFile();
      return 0;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.warn(
    `Daemon did not exit within ${GRACEFUL_TIMEOUT_MS / 1000}s — sending SIGKILL`,
  );
  try {
    process.kill(pidInfo.pid, "SIGKILL");
  } catch {
    /* may already have died */
  }
  await sleep(500);

  if (isPidAlive(pidInfo.pid)) {
    console.error(`✗ Failed to kill pid ${pidInfo.pid}`);
    return 1;
  }

  console.log("✓ Daemon killed");
  removePidFile();
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
