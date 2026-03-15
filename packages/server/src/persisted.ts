/**
 * Session persistence — all sessions survive server reboots by default.
 *
 * Sessions are auto-persisted when created and removed from persistence
 * only when explicitly exited or killed.
 *
 * Storage: ~/.autonomos/sessions.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./configDir.js";

export interface PersistedSession {
  claudeSessionId: string;
  workingDirectory: string;
  name: string;
  autonomousMode: boolean;
  persistedAt: number;
}

const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

let lastReadFailed = false;

function readSessions(): PersistedSession[] {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.warn("Persisted sessions file is not an array, ignoring");
      lastReadFailed = true;
      return [];
    }
    lastReadFailed = false;
    return data.filter(
      (p): p is PersistedSession =>
        typeof p?.claudeSessionId === "string" &&
        typeof p?.workingDirectory === "string" &&
        typeof p?.name === "string" &&
        typeof p?.autonomousMode === "boolean",
    );
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      lastReadFailed = false;
      return [];
    }
    console.error(
      `Failed to read persisted sessions (file will NOT be overwritten): ${err}`,
    );
    lastReadFailed = true;
    return [];
  }
}

function writeSessions(sessions: PersistedSession[]): void {
  if (lastReadFailed) {
    console.error(
      "Refusing to write sessions — last read failed (would destroy data)",
    );
    return;
  }
  ensureConfigDir();
  writeFileSync(SESSIONS_FILE, `${JSON.stringify(sessions, null, 2)}\n`, {
    mode: 0o600,
  });
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
