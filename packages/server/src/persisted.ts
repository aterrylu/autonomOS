/**
 * Session persistence — all sessions survive server reboots by default.
 *
 * Sessions are auto-persisted when created and removed from persistence
 * only when explicitly exited or killed.
 *
 * Storage: ~/.autonomos/sessions.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PersistedSession {
  claudeSessionId: string;
  workingDirectory: string;
  name: string;
  autonomousMode: boolean;
  persistedAt: number;
}

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");
const CONFIG_DIR = join(HOME, ".autonomos");
const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readSessions(): PersistedSession[] {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.warn("Persisted sessions file is not an array, ignoring");
      return [];
    }
    return data.filter(
      (p): p is PersistedSession =>
        typeof p?.claudeSessionId === "string" &&
        typeof p?.workingDirectory === "string" &&
        typeof p?.name === "string" &&
        typeof p?.autonomousMode === "boolean",
    );
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    console.warn(`Failed to read persisted sessions: ${err}`);
    return [];
  }
}

function writeSessions(sessions: PersistedSession[]): void {
  ensureConfigDir();
  writeFileSync(SESSIONS_FILE, `${JSON.stringify(sessions, null, 2)}\n`);
}

export function getPersistedSessions(): PersistedSession[] {
  return readSessions();
}

export function persistSession(session: PersistedSession): void {
  const sessions = readSessions();
  const idx = sessions.findIndex(
    (s) => s.claudeSessionId === session.claudeSessionId,
  );
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  writeSessions(sessions);
}

export function removePersistedSession(claudeSessionId: string): void {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.claudeSessionId === claudeSessionId);
  if (idx >= 0) {
    sessions.splice(idx, 1);
    writeSessions(sessions);
  }
}
