/**
 * Pinned sessions — survive server reboots.
 *
 * A pinned session saves its config (claudeSessionId, cwd, name, autonomousMode)
 * to a JSON file. On server startup, all pinned sessions are auto-resumed.
 *
 * Storage: ~/.autonomos/pinned-sessions.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PinnedSession {
  /** The Claude Code session ID (used for --resume) */
  claudeSessionId: string;
  /** Working directory */
  workingDirectory: string;
  /** Display name */
  name: string;
  /** Whether to run in autonomous mode */
  autonomousMode: boolean;
  /** When this session was pinned */
  pinnedAt: number;
}

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");
const CONFIG_DIR = join(HOME, ".autonomos");
const PINNED_FILE = join(CONFIG_DIR, "pinned-sessions.json");

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readPinned(): PinnedSession[] {
  try {
    const raw = readFileSync(PINNED_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.warn(`Pinned sessions file is not an array, ignoring`);
      return [];
    }
    return data.filter(
      (p): p is PinnedSession =>
        typeof p?.claudeSessionId === "string" &&
        typeof p?.workingDirectory === "string" &&
        typeof p?.name === "string" &&
        typeof p?.autonomousMode === "boolean",
    );
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return []; // File doesn't exist yet — expected on first run
    }
    console.warn(`Failed to read pinned sessions: ${err}`);
    return [];
  }
}

function writePinned(sessions: PinnedSession[]): void {
  ensureConfigDir();
  writeFileSync(PINNED_FILE, JSON.stringify(sessions, null, 2) + "\n");
}

export function getPinnedSessions(): PinnedSession[] {
  return readPinned();
}

export function pinSession(session: PinnedSession): void {
  const pinned = readPinned();
  // Replace if already pinned (by claudeSessionId)
  const idx = pinned.findIndex(
    (p) => p.claudeSessionId === session.claudeSessionId,
  );
  if (idx >= 0) {
    pinned[idx] = session;
  } else {
    pinned.push(session);
  }
  writePinned(pinned);
}

export function unpinSession(claudeSessionId: string): boolean {
  const pinned = readPinned();
  const idx = pinned.findIndex((p) => p.claudeSessionId === claudeSessionId);
  if (idx < 0) return false;
  pinned.splice(idx, 1);
  writePinned(pinned);
  return true;
}

export function isPinned(claudeSessionId: string): boolean {
  return readPinned().some((p) => p.claudeSessionId === claudeSessionId);
}
