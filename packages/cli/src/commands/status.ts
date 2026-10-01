// `autonomos status` — print the running daemon's state, or "not running".
//
// Sources of truth, in order of authority:
//   1. PID file at $configDir/autonomos.pid — primary source (written by daemon
//      on listen, removed on shutdown)
//   2. /api/host HTTP probe — secondary confirmation that the daemon is
//      actually responsive (not just running but unresponsive)
//
// Exit codes:
//   0 — daemon running and responsive
//   1 — PID file present but process is gone (stale PID file)
//   2 — daemon not running (no PID file)
//   3 — daemon running but HTTP probe failed (process up, server stuck)

import { resolve } from "node:path";
import {
  isPidAlive,
  readPidFile,
  removePidFile,
} from "@autonomos/server/pid-file.js";
import {
  checkInstalledFloors,
  defaultServerDir,
  formatFloorViolations,
} from "@autonomos/server/securityFloors.js";

export async function runStatusCommand(): Promise<number> {
  const pidInfo = readPidFile();

  if (pidInfo === null) {
    console.log("autonomOS daemon: not running");
    return 2;
  }

  if (!isPidAlive(pidInfo.pid)) {
    console.log(
      `autonomOS daemon: stale PID file (pid ${pidInfo.pid} no longer exists)`,
    );
    console.log("Cleaning up stale PID file...");
    removePidFile();
    return 1;
  }

  // Process is alive — verify HTTP responsiveness
  const url = `http://127.0.0.1:${pidInfo.port}/api/host`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      console.log(
        `autonomOS daemon: pid ${pidInfo.pid} alive but /api/host returned ${resp.status}`,
      );
      return 3;
    }
    const { hostname } = (await resp.json()) as { hostname: string };
    const uptimeSec = Math.floor(
      (Date.now() - new Date(pidInfo.startedAt).getTime()) / 1000,
    );
    console.log(`autonomOS daemon: running`);
    console.log(`  version:  ${pidInfo.version}`);
    console.log(`  pid:      ${pidInfo.pid}`);
    console.log(`  port:     ${pidInfo.port}`);
    console.log(`  hostname: ${hostname}`);
    console.log(`  uptime:   ${formatUptime(uptimeSec)}`);
    console.log(`  url:      http://127.0.0.1:${pidInfo.port}/`);
    printSecurityFloors();
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `autonomOS daemon: pid ${pidInfo.pid} alive but unreachable at ${url} (${msg})`,
    );
    return 3;
  }
}

/** The installed tree's security floors (V12b, ADR-137). Informational: the
 *  exit codes above are a contract for scripts and supervisors, so this never
 *  changes them. Always prints a verdict: "n/a" for a bundle install (its
 *  dependencies were inlined from a fresh install at release time), never
 *  silence that reads as a pass. */
function printSecurityFloors(): void {
  const violations = checkInstalledFloors();
  if (violations === null) {
    console.log("  security floors: n/a (bundle install)");
    return;
  }
  if (violations.length === 0) {
    console.log("  security floors: ok");
    return;
  }
  console.log("  security floors: NOT MET");
  console.log("");
  console.log(
    formatFloorViolations(violations, resolve(defaultServerDir(), "..", "..")),
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
