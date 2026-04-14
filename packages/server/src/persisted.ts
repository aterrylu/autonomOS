/**
 * Session persistence — all sessions survive server reboots by default.
 *
 * Sessions are auto-persisted when created and removed from persistence
 * only when explicitly exited or killed.
 *
 * Storage: ~/.autonomos/sessions.json (or AUTONOMOS_CONFIG_DIR override)
 *
 * Safety:
 * - In-memory cache prevents read-modify-write races during concurrent mutations
 * - Backup created before any write that reduces session count (guards against corruption)
 * - writeFileSync ensures atomic-enough writes (no interleaving)
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "./configDir.js";

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

function getSessionsFile(): string {
  return join(getConfigDir(), "sessions.json");
}

// ── In-memory cache ─────────────────────────────────────────────────
// All mutations go through the cache. readSessions() populates it on
// first call; subsequent calls return the cached copy. This eliminates
// TOCTOU races where two concurrent read-modify-write cycles could
// lose each other's changes.
let sessionsCache: PersistedSession[] | null = null;
let lastReadFailed = false;

function loadFromDisk(): PersistedSession[] {
  const file = getSessionsFile();
  try {
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.error(
        "Persisted sessions file is not an array — persistence is degraded",
      );
      lastReadFailed = true;
      return [];
    }
    lastReadFailed = false;
    return data
      .filter(
        (p): p is PersistedSession =>
          typeof p?.claudeSessionId === "string" &&
          typeof p?.workingDirectory === "string" &&
          typeof p?.name === "string",
      )
      .map((p) => ({
        ...p,
        autonomousMode: p.autonomousMode ?? true,
        persistedAt: p.persistedAt ?? 0,
      }));
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

function readSessions(): PersistedSession[] {
  if (sessionsCache === null) {
    sessionsCache = loadFromDisk();
  }
  return sessionsCache;
}

function writeSessions(sessions: PersistedSession[]): void {
  if (lastReadFailed) {
    console.error(
      `Refusing to write ${sessions.length} sessions — last read failed (would destroy data). Fix or remove ${getSessionsFile()} and restart.`,
    );
    return;
  }

  const file = getSessionsFile();

  // Backup before destructive writes (entry count decreased).
  // Compare against the cached count — no need to re-read the file.
  const prevCount = sessionsCache?.length ?? 0;
  if (sessions.length < prevCount) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch (backupErr) {
      console.warn(`Failed to create sessions.json backup: ${backupErr}`);
    }
  }

  ensureConfigDir();
  writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, {
    mode: 0o600,
  });

  // Keep cache in sync
  sessionsCache = sessions;
}

export function getPersistedSessions(): PersistedSession[] {
  return [...readSessions()];
}

export function persistSession(session: PersistedSession): void {
  const sessions = readSessions();
  const idx = sessions.findIndex(
    (s) => s.claudeSessionId === session.claudeSessionId,
  );
  if (idx >= 0) {
    // Merge: preserve existing optional fields when new values are undefined.
    // This prevents losing manager/template/project during re-persist on resume.
    const existing = sessions[idx];
    sessions[idx] = {
      ...existing,
      ...session,
      template: session.template ?? existing.template,
      manager: session.manager ?? existing.manager,
      project: session.project ?? existing.project,
      status: session.status ?? existing.status,
    };
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
  const idx = sessions.findIndex(
    (s) => s.name && s.name.toLowerCase() === lower,
  );
  if (idx < 0) return false;
  sessions[idx] = { ...sessions[idx], ...updates };
  writeSessions(sessions);
  return true;
}

/** For testing — clear the in-memory cache so the next read hits disk. */
export function _resetCacheForTesting(): void {
  sessionsCache = null;
  lastReadFailed = false;
}
