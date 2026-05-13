// `autonomos stop` — gracefully shut down the running daemon.
//
// Reads PID file, sends SIGTERM, waits up to 10s for the process to exit.
// If it doesn't exit by then, escalates to SIGKILL and warns.
//
// Exit codes:
//   0 — daemon successfully stopped (or wasn't running to begin with)
//   1 — failed to stop (process still alive after SIGKILL)

import {
  isPidAlive,
  readPidFile,
  removePidFile,
} from "@autonomos/server/pid-file.js";

const GRACEFUL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

export async function runStopCommand(): Promise<number> {
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
