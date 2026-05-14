// Daemon PID file utilities — written by runServer() on listen, removed on
// shutdown. Read by the CLI to find a running daemon for stop/status/upgrade.
//
// Location: `${configDir()}/autonomos.pid` (configDir respects
// AUTONOMOS_CONFIG_DIR, which is critical for isolated tests).
//
// Format: JSON object with pid, port, version, startedAt — JSON instead of a
// flat number so we can carry the daemon's port and version forward.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
