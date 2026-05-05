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

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ExitReason, Provider } from "@autonomos/core";
import { getConfigDir } from "../configDir.js";
import { agentsDirExists, buildAgent, insertAgent } from "./store.js";

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
  if (agentsDirExists()) return { status: "skipped" };

  const sessionsPath = getSessionsJsonPath();
  if (!existsSync(sessionsPath)) {
    // Fresh install — no source file. Caller should still ensure agents/ exists.
    return { status: "no-source" };
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
      autonomousMode: s.autonomousMode ?? true,
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

  // Write all per-file records FIRST. If any throws, leave sessions.json untouched.
  for (const agent of agents) {
    insertAgent(agent);
  }

  // All writes succeeded — rename the source as the rollback artifact.
  const backupPath = `${sessionsPath}.premigration-${timestampSuffix()}`;
  try {
    renameSync(sessionsPath, backupPath);
  } catch (err) {
    console.warn(
      `[migrate] migrated ${agents.length} agents successfully but failed to rename source file: ${err}. ` +
        `Manually move ${sessionsPath} → ${backupPath} to suppress repeat-migration attempts.`,
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
