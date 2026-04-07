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
  /** Template used to spawn this agent (e.g. "team-lead") */
  template?: string;
  /** Manager agent name for org chart (e.g. "CEO@company") */
  manager?: string;
  /** Project scope (e.g. "autonomOS") */
  project?: string;
  /** Session lifecycle status. Missing means "running" (backward compat). */
  status?: "running" | "exited";
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

export function removePersistedSession(claudeSessionId: string): boolean {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.claudeSessionId === claudeSessionId);
  if (idx >= 0) {
    sessions.splice(idx, 1);
    writeSessions(sessions);
    return true;
  }
  return false;
}

/** Mark a persisted session as exited (instead of deleting it) */
export function markSessionExited(claudeSessionId: string): void {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.claudeSessionId === claudeSessionId);
  if (idx < 0) return;
  if (sessions[idx].status === "exited") return;
  sessions[idx].status = "exited";
  writeSessions(sessions);
}

/** Batch-update persisted names for sessions (single read-modify-write cycle) */
export function batchUpdatePersistedSessionNames(
  updates: Array<{ claudeSessionId: string; name: string }>,
): void {
  if (updates.length === 0) return;
  const sessions = readSessions();
  let dirty = false;
  for (const { claudeSessionId, name } of updates) {
    const idx = sessions.findIndex(
      (s) => s.claudeSessionId === claudeSessionId,
    );
    if (idx >= 0 && sessions[idx].name !== name) {
      sessions[idx].name = name;
      dirty = true;
    }
  }
  if (dirty) writeSessions(sessions);
}

/** Update specific fields on a persisted session (by name, case-insensitive) */
export function updatePersistedSessionByName(
  name: string,
  updates: Partial<Pick<PersistedSession, "manager" | "project" | "template">>,
): boolean {
  const sessions = readSessions();
  const lower = name.toLowerCase();
  const idx = sessions.findIndex((s) => s.name.toLowerCase() === lower);
  if (idx < 0) return false;
  sessions[idx] = { ...sessions[idx], ...updates };
  writeSessions(sessions);
  return true;
}
