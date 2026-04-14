/**
 * Schedule CRUD — reads/writes ~/.autonomos/schedules/<name>.json
 *
 * Mirrors the templates.ts pattern: one JSON file per schedule,
 * name-validated for path safety. Each file contains config (agent-editable)
 * + state (server-managed) in a single object.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RunRecord,
  Schedule,
  ScheduleConfig,
  ScheduleState,
} from "@autonomos/core";
import { CONFIG_DIR } from "./configDir.js";

const SCHEDULES_DIR = join(CONFIG_DIR, "schedules");
const RUNS_DIR = join(CONFIG_DIR, "schedule-runs");

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid schedule name "${name}": must be lowercase letters, digits, and hyphens`,
    );
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const DEFAULT_STATE: ScheduleState = {
  lastRunAt: null,
  lastRunStatus: null,
  nextRunAt: null,
  runCount: 0,
  consecutiveFailures: 0,
  currentRunId: null,
};

// ── Schedule CRUD ───────────────────────────────────────────────

export function getSchedule(name: string): Schedule | null {
  validateName(name);
  const filePath = join(SCHEDULES_DIR, `${name}.json`);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Schedule;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(
      `Failed to load schedule "${name}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function saveSchedule(name: string, schedule: Schedule): void {
  validateName(name);
  ensureDir(SCHEDULES_DIR);
  const filePath = join(SCHEDULES_DIR, `${name}.json`);
  writeFileSync(filePath, `${JSON.stringify(schedule, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Create a new schedule from config. Initializes state with defaults.
 * Throws if a schedule with this name already exists.
 */
export function createSchedule(config: ScheduleConfig): Schedule {
  validateName(config.name);
  const existing = getSchedule(config.name);
  if (existing) {
    throw new Error(`Schedule "${config.name}" already exists`);
  }
  const schedule: Schedule = { ...config, state: { ...DEFAULT_STATE } };
  saveSchedule(config.name, schedule);
  return schedule;
}

/**
 * Partial update — merges provided config fields, preserves state.
 * Returns the updated schedule. Throws if not found.
 */
export function updateSchedule(
  name: string,
  partial: Partial<ScheduleConfig>,
): Schedule {
  const existing = getSchedule(name);
  if (!existing) {
    throw new Error(`Schedule "${name}" not found`);
  }
  const updated: Schedule = {
    ...existing,
    ...partial,
    name: existing.name,
    state: existing.state,
  };
  saveSchedule(name, updated);
  return updated;
}

export function deleteSchedule(name: string): boolean {
  validateName(name);
  const filePath = join(SCHEDULES_DIR, `${name}.json`);
  try {
    unlinkSync(filePath);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw new Error(
      `Failed to delete schedule "${name}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function listSchedules(): Record<string, Schedule> {
  ensureDir(SCHEDULES_DIR);
  const result: Record<string, Schedule> = {};
  const files = readdirSync(SCHEDULES_DIR);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.replace(/\.json$/, "");
    try {
      const schedule = getSchedule(name);
      if (schedule) result[name] = schedule;
    } catch (err) {
      console.warn(
        `Skipping corrupt schedule "${name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

// ── Run History (JSONL) ─────────────────────────────────────────

export function appendRun(name: string, record: RunRecord): void {
  validateName(name);
  ensureDir(RUNS_DIR);
  const filePath = join(RUNS_DIR, `${name}.jsonl`);
  appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export function getRecentRuns(name: string, limit = 10): RunRecord[] {
  validateName(name);
  const filePath = join(RUNS_DIR, `${name}.jsonl`);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const runs: RunRecord[] = [];
    const start = Math.max(0, lines.length - limit);
    for (let i = start; i < lines.length; i++) {
      try {
        runs.push(JSON.parse(lines[i]) as RunRecord);
      } catch {
        // skip corrupt lines
      }
    }
    return runs;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }
}

export function pruneRuns(name: string, maxLines = 2000): void {
  validateName(name);
  const filePath = join(RUNS_DIR, `${name}.jsonl`);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length <= maxLines) return;
    const kept = lines.slice(lines.length - maxLines);
    writeFileSync(filePath, `${kept.join("\n")}\n`, { mode: 0o600 });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Update only the state section of a schedule on disk.
 * Used by the scheduler engine to persist run status without
 * touching config fields.
 */
export function updateScheduleState(
  name: string,
  state: Partial<ScheduleState>,
): Schedule | null {
  const existing = getSchedule(name);
  if (!existing) return null;
  existing.state = { ...existing.state, ...state };
  saveSchedule(name, existing);
  return existing;
}
