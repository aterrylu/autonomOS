/**
 * One-shot migration: ~/.autonomos/sessions.json → ~/.autonomos/agents/<id>.json
 *
 * Trigger: server startup, before HTTP listener opens. Process-manager-agnostic
 * — runs identically under pm2, npx, bun, manual node invocation, or a desktop
 * client bootstrapping a fresh remote server over SSH.
 *
 * Idempotency: detected via agents/ dir presence. Once migrated, this is a
 * no-op forever.
 *
 * Safety: source file (sessions.json) is NOT touched until every per-agent
 * file has been written successfully. Mid-migration crash leaves the source
 * intact; next startup retries cleanly.
 *
 * Mapping (Option A): agent.id reuses the old claudeSessionId, preserving
 * any external references (schedules with `target: agent:<id>`, scripts, etc.).
 */

import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  DEFAULT_PERMISSION_MODE,
  type ExitReason,
  type Provider,
  permissionModeFromLegacy,
} from "@autonomos/core";
import { getConfigDir } from "../configDir.js";
import {
  buildAgent,
  getAgentsDir,
  insertAgent,
  isMigrationComplete,
  markMigrationComplete,
} from "./store.js";

interface LegacyPersistedSession {
  claudeSessionId: string;
  workingDirectory: string;
  name: string;
  autonomousMode?: boolean;
  persistedAt?: number;
  template?: string;
  manager?: string;
  project?: string;
  status?: "running" | "exited";
  exitedAt?: number;
  exitReason?: ExitReason;
}

function getSessionsJsonPath(): string {
  return join(getConfigDir(), "sessions.json");
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Run the migration if needed. Returns a summary describing what happened.
 *
 * Safe to call on every startup — checks idempotency itself.
 */
export function migrateIfNeeded(): {
  status: "skipped" | "migrated" | "no-source";
  agents?: number;
  managersResolved?: number;
  orphaned?: number;
} {
  // Idempotency: a sentinel file written ONLY after a successful migration
  // (or a fresh install) lets a mid-crash retry re-attempt cleanly. Using
  // the agents/ dir's existence here would mark partial state as "done"
  // because writing the first per-agent file creates the dir.
  if (isMigrationComplete()) return { status: "skipped" };

  const sessionsPath = getSessionsJsonPath();
  if (!existsSync(sessionsPath)) {
    // Fresh install — no source file. Mark complete so we don't re-check
    // every startup forever. Wrapped to match the post-rename branch:
    // a transient marker-write failure shouldn't crashloop the server
    // with a misleading "investigate sessions.json" message when there
    // was never a sessions.json. Re-checking every startup is harmless
    // (single stat call).
    try {
      markMigrationComplete();
    } catch (err) {
      console.warn(
        `[migrate] no source file but marker write failed: ${err instanceof Error ? err.message : err}. Will retry next startup.`,
      );
    }
    return { status: "no-source" };
  }

  // Detect inconsistent state: agents/*.json populated AND sessions.json
  // STILL present AND no .migration-complete marker. Two ways to arrive here:
  //   1. Pre-#166 code: wrote per-agent files first, only console.warn'd on
  //      renameSync failure — silently left this exact state.
  //   2. Current code: throwing renameSync hit transient EPERM/EROFS, so
  //      migrateIfNeeded threw mid-loop. Some agent files may be on disk
  //      (write loop ran before the rename throw); marker not written.
  // If we proceed naively, insertAgent overwrites every agents/*.json
  // from sessions.json — silently clobbering either (a) post-old-migration
  // mutations the user made via new write paths (set_manager, rename), or
  // (b) the partial state of an interrupted current-version migration.
  // Refuse to proceed and surface a neutral, actionable error.
  let preExistingAgentFileCount = 0;
  try {
    preExistingAgentFileCount = readdirSync(getAgentsDir()).filter((n) =>
      n.endsWith(".json"),
    ).length;
  } catch (err) {
    // ENOENT = dir doesn't exist yet (clean state, proceed). Anything else
    // (EACCES, EIO, etc.) means the safety check itself can't run — refuse
    // rather than silently bypassing the guard.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new Error(
        `[migrate] cannot inspect ${getAgentsDir()} to verify safe-to-migrate state: ${err instanceof Error ? err.message : err}. ` +
          `Resolve the access error and restart.`,
      );
    }
  }
  if (preExistingAgentFileCount > 0) {
    throw new Error(
      `[migrate] inconsistent state: ${preExistingAgentFileCount} agent file(s) exist in ${getAgentsDir()} ` +
        `but no .migration-complete marker AND ${sessionsPath} still present. ` +
        `Caused either by a pre-#166 silent rename failure OR a current-version migration that crashed after writing per-agent file(s) but before/during the source rename. ` +
        `Resolve manually: prefer (b) unless you have manually verified every per-agent file is complete and current. ` +
        `(a) delete ${sessionsPath} ONLY if the per-agent files reflect current intended state, then touch ${getAgentsDir()}/.migration-complete; ` +
        `or (b) move ${getAgentsDir()} aside and let migration re-run cleanly from ${sessionsPath}.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(sessionsPath, "utf-8");
  } catch (err) {
    console.error(
      `[migrate] failed to read ${sessionsPath}: ${err}. Aborting migration.`,
    );
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[migrate] sessions.json is not valid JSON: ${err}. Aborting migration so the source is preserved.`,
    );
    throw err;
  }
  if (!Array.isArray(parsed)) {
    console.error(
      `[migrate] sessions.json root is not an array. Aborting migration so the source is preserved.`,
    );
    throw new Error("sessions.json: expected top-level array");
  }

  // Validate + filter
  const valid: LegacyPersistedSession[] = [];
  for (const entry of parsed) {
    if (
      typeof entry?.claudeSessionId === "string" &&
      typeof entry?.workingDirectory === "string" &&
      typeof entry?.name === "string"
    ) {
      valid.push(entry as LegacyPersistedSession);
    } else {
      console.warn(
        `[migrate] skipping malformed sessions.json entry: ${JSON.stringify(entry)?.slice(0, 200)}`,
      );
    }
  }

  if (valid.length === 0) {
    // Empty (or all-malformed) source — treat as fresh install but preserve
    // the file so the user can inspect.
    console.log(`[migrate] sessions.json had no valid entries; skipping`);
    return { status: "no-source" };
  }

  // Build lowercased-name → canonical claudeSessionId map for manager resolution.
  // Same canonicalization rules as the old chooseCanonical: prefer running,
  // newest persistedAt wins on ties.
  const byName = new Map<string, LegacyPersistedSession[]>();
  for (const s of valid) {
    const key = s.name.toLowerCase();
    const bucket = byName.get(key);
    if (bucket) bucket.push(s);
    else byName.set(key, [s]);
  }
  const nameToId = new Map<string, string>();
  for (const [key, bucket] of byName) {
    const running = bucket.filter((s) => s.status !== "exited");
    const pool = running.length > 0 ? running : bucket;
    let best = pool[0];
    for (const s of pool) {
      if ((s.persistedAt ?? 0) > (best.persistedAt ?? 0)) best = s;
    }
    nameToId.set(key, best.claudeSessionId);
  }

  // Build + persist Agent records
  let managersResolved = 0;
  let orphaned = 0;
  const agents: Agent[] = [];
  for (const s of valid) {
    const managerId = s.manager ? nameToId.get(s.manager.toLowerCase()) : null;
    if (s.manager && !managerId) {
      orphaned++;
    } else if (managerId) {
      managersResolved++;
    }

    const agent = buildAgent({
      id: s.claudeSessionId,
      name: s.name,
      workingDirectory: s.workingDirectory,
      provider: "claude-code" as Provider,
      providerSessionId: s.claudeSessionId,
      permissionMode:
        permissionModeFromLegacy(s.autonomousMode) ?? DEFAULT_PERMISSION_MODE,
      template: s.template,
      managerId: managerId ?? null,
      project: s.project,
      status: s.status === "exited" ? "exited" : "running",
      startedAt: s.persistedAt ?? Date.now(),
      createdAt: s.persistedAt ?? Date.now(),
    });
    if (s.status === "exited") {
      agent.exitedAt = s.exitedAt;
      agent.exitReason = s.exitReason;
    }
    agents.push(agent);
  }

  // Write all per-file records FIRST. If any throws, leave sessions.json
  // untouched AND skip writing the migration-complete marker — the next
  // startup will retry. insertAgent overwrites by id, so re-running is
  // safe (idempotent on the per-agent files).
  for (const agent of agents) {
    insertAgent(agent);
  }

  // All writes succeeded — rename the source as the rollback artifact.
  // We must throw on rename failure (not just warn) so the marker isn't
  // written: leaving the source in place AND marking complete would let
  // a future reset of agents/ silently re-introduce stale records.
  const backupPath = `${sessionsPath}.premigration-${timestampSuffix()}`;
  try {
    renameSync(sessionsPath, backupPath);
  } catch (err) {
    throw new Error(
      `[migrate] wrote ${agents.length} agent files but FAILED to rename ${sessionsPath} → ${backupPath}: ${err instanceof Error ? err.message : err}. ` +
        `Resolve the rename (likely a permissions or read-only-fs issue) and restart.`,
    );
  }

  // Atomically signal "migration done" so subsequent startups skip the work.
  // If this throws (disk full, EPERM on the marker), don't fail startup —
  // the migration itself succeeded (per-agent files written, source renamed).
  // Worst case: next startup takes the no-source path and writes the marker
  // there. A noisy fatal exit on the marker write would mask the success.
  try {
    markMigrationComplete();
  } catch (err) {
    console.warn(
      `[migrate] migration succeeded but marker write failed: ${err instanceof Error ? err.message : err}. ` +
        `Next startup will reconcile via the no-source path.`,
    );
  }

  console.log(
    `[migrate] migrated ${agents.length} agent(s) from sessions.json ` +
      `(${managersResolved} with manager resolved, ${orphaned} orphaned). ` +
      `Backup: ${backupPath}`,
  );

  return {
    status: "migrated",
    agents: agents.length,
    managersResolved,
    orphaned,
  };
}
