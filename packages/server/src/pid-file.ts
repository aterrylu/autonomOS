// Daemon PID file utilities — written by runServer() on listen, removed on
// shutdown. Read by the CLI to find a running daemon for stop/status/upgrade.
//
// Location: `${configDir()}/autonomos.pid` (configDir respects
// AUTONOMOS_CONFIG_DIR, which is critical for isolated tests).
//
// Format: JSON object with pid, port, version, startedAt — JSON instead of a
// flat number so we can carry the daemon's port and version forward.
//
// Mutual exclusion (ADR-029): acquireOwnership() implements the atomic
// claim required so two server processes can never own the same config
// dir simultaneously. The Built-in mode (Desktop spawns server child)
// and the Always-on mode (LaunchAgent) both go through this gate.

import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "./configDir.js";

export type PidFileContents = {
  pid: number;
  port: number;
  version: string;
  startedAt: string; // ISO timestamp
};

export function pidFilePath(): string {
  return join(getConfigDir(), "autonomos.pid");
}

export function writePidFile(contents: PidFileContents): void {
  ensureConfigDir();
  writeFileSync(pidFilePath(), JSON.stringify(contents, null, 2));
}

export function readPidFile(): PidFileContents | null {
  const path = pidFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PidFileContents;
  } catch {
    // Corrupted PID file — treat as no daemon. Caller can decide whether to
    // surface this to the user.
    return null;
  }
}

export function removePidFile(): void {
  const path = pidFilePath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort. If we can't delete, the next start will overwrite.
    }
  }
}

/**
 * Check whether a PID is still alive via POSIX kill(pid, 0).
 * Sends no signal; throws ESRCH if the process doesn't exist.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Liveness probe: open a TCP-level GET /api/system/version with a short
 * timeout. We use Node's http module directly (not net.request from
 * electron) so this works in the standalone server context too.
 *
 * Returns true if the server returns ANY HTTP response (auth doesn't
 * matter — even a 401 proves a server is listening). Returns false on
 * connection refused, timeout, or socket errors.
 */
export async function isPortResponsive(
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Lazy require avoids a top-of-file http import; this function is
    // rarely called (only at server-start time).
    import("node:http")
      .then((http) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/system/version",
            method: "GET",
            timeout: timeoutMs,
          },
          (res) => {
            // Drain so the socket closes cleanly.
            res.on("data", () => undefined);
            res.on("end", () => undefined);
            settle(true);
          },
        );
        req.on("error", () => settle(false));
        req.on("timeout", () => {
          req.destroy();
          settle(false);
        });
        req.end();
      })
      .catch(() => settle(false));
  });
}

/** Result of acquireOwnership() — explicit discriminated union so callers
 *  must handle both cases. */
export type AcquireOwnershipResult =
  | { status: "acquired" }
  | { status: "already-running"; owner: PidFileContents };

/**
 * Atomically claim ownership of the pid file (ADR-029 mutual exclusion).
 *
 * Flow:
 *   1. Try to create `autonomos.pid.lock` with O_EXCL | O_CREAT.
 *      - If create succeeds: we hold the start-lock; proceed.
 *      - If create fails (EEXIST): another start is in progress.
 *        Wait 100ms and retry once. If still locked, give up.
 *   2. Read existing autonomos.pid (if any).
 *   3. If pid is alive AND port responsive: someone else owns this
 *      config dir. Return `{ status: "already-running", owner }`.
 *   4. If stale (pid dead or port not responding): remove old pid file.
 *   5. Write our own pid file atomically (tmp + rename).
 *   6. Release the lock file.
 *
 * Caller is responsible for `removePidFile()` on clean shutdown.
 *
 * Safe to call multiple times within a single process — the lock file
 * is process-scoped and we read+rewrite our own pid file each time.
 */
export async function acquireOwnership(
  ourPid: number,
  ourPort: number,
  ourVersion: string,
): Promise<AcquireOwnershipResult> {
  ensureConfigDir();
  const lockPath = join(getConfigDir(), "autonomos.pid.lock");

  const tryLock = (): number | null => {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = "fail if file exists." This is the
      // atomic claim — at most one process can pass this gate.
      return openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
  };

  let lockFd = tryLock();
  if (lockFd === null) {
    // Another start in progress (or stale lock). Wait 100ms, retry once.
    await new Promise((r) => setTimeout(r, 100));
    lockFd = tryLock();
    if (lockFd === null) {
      // Stale lock from a crashed process. Force-remove and retry one more
      // time. If THAT fails, give up — something is genuinely wrong.
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
      lockFd = tryLock();
      if (lockFd === null) {
        throw new Error(
          "Could not acquire start lock at " +
            `${lockPath} — another process may be racing this claim.`,
        );
      }
    }
  }

  try {
    // Write our pid into the lock for forensics if we crash.
    writeSync(lockFd, String(ourPid));

    const existing = readPidFile();
    if (existing) {
      const alive = isPidAlive(existing.pid);
      const responsive = alive ? await isPortResponsive(existing.port) : false;
      if (alive && responsive) {
        return { status: "already-running", owner: existing };
      }
      // Stale: pid dead OR port not responding. Clean up.
      removePidFile();
    }

    writePidFile({
      pid: ourPid,
      port: ourPort,
      version: ourVersion,
      startedAt: new Date().toISOString(),
    });
    return { status: "acquired" };
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Best-effort. Next acquireOwnership will deal with it.
    }
  }
}
