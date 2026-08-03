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
import { SUPPORTED_OVERLAP_POLICIES } from "@autonomos/core";
import { Cron } from "croner";
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
    // 0700: schedule configs + run history hold prompts (and, historically,
    // system-prompt-adjacent content) — owner-only, so another local user
    // can't read them. Mode applies on creation only; existing dirs are left
    // as-is to avoid surprising an install that deliberately loosened them.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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

/**
 * Reject a schedule file that isn't a well-formed Schedule BEFORE the scheduler
 * acts on it. A bare `JSON.parse(...) as Schedule` accepts `[]`, `[{...}]`, or a
 * truncated object — every one of which loads as a "valid" schedule whose
 * missing `enabled`/`schedule`/`target` then drives cron construction or a
 * gateway send off undefined values (a Cron parse throw, or a send to
 * `agent:undefined`). Validate only the invariants: object shape + the five
 * genuinely-required fields. Deprecated/accepted-and-ignored fields
 * (`template`, `autonomous`, `onComplete`, …) are deliberately NOT checked, so
 * a pre-removal file still loads. Mirrors the templates.ts shape guard.
 */
function assertScheduleShape(parsed: unknown, filePath: string): Schedule {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    let found: string;
    if (Array.isArray(parsed)) found = "an array";
    else if (parsed === null) found = "null";
    else found = `a ${typeof parsed}`;
    throw new Error(
      `expected a JSON object, found ${found} — check ${filePath} for a truncated or list-wrapped write`,
    );
  }
  const s = parsed as Record<string, unknown>;
  for (const field of ["name", "schedule", "target", "prompt"] as const) {
    if (typeof s[field] !== "string") {
      throw new Error(
        `schedule ${filePath} is missing a string "${field}" — refusing to load a malformed schedule`,
      );
    }
  }
  if (typeof s.enabled !== "boolean") {
    throw new Error(
      `schedule ${filePath} is missing a boolean "enabled" — refusing to load a malformed schedule`,
    );
  }
  return parsed as Schedule;
}

export function getSchedule(name: string): Schedule | null {
  validateName(name);
  const filePath = join(SCHEDULES_DIR, `${name}.json`);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return assertScheduleShape(JSON.parse(raw), filePath);
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

// ── Input validation ────────────────────────────────────────────

/**
 * Validate schedule config input. Used by REST + MCP create/update handlers
 * so invalid cron, `once:` dates, targets, or overlap policies are rejected
 * up-front instead of silently disabling the schedule in `addScheduleJob`.
 *
 * Pass `existing` on update so cron is validated against the effective
 * timezone (new value if provided, else existing).
 * Returns null on success, or an error message suitable for a 400 response.
 */
export function validateScheduleInput(
  input: Partial<ScheduleConfig>,
  opts: { existing?: Schedule } = {},
): string | null {
  if (input.schedule !== undefined) {
    if (typeof input.schedule !== "string" || !input.schedule.trim()) {
      return "schedule must be a non-empty string";
    }
    if (input.schedule.startsWith("once:")) {
      const d = new Date(input.schedule.slice("once:".length));
      if (Number.isNaN(d.getTime())) {
        return "Invalid one-time date format";
      }
    } else {
      const tz = input.timezone ?? opts.existing?.timezone;
      try {
        new Cron(input.schedule, { timezone: tz || undefined });
      } catch (err) {
        return `Invalid cron expression: ${err instanceof Error ? err.message : err}`;
      }
    }
  }

  if (input.target !== undefined) {
    if (typeof input.target !== "string" || !input.target.trim()) {
      return "target must be a non-empty string";
    }
    // "isolated" gets its own message. Folding it into the generic error would
    // tell an operator with a pre-removal schedule that their target is
    // "invalid" without saying it used to be valid, or what replaces it.
    if (input.target === "isolated") {
      return `The "isolated" target was removed — a schedule now sends its prompt to a running agent. Use "agent:<name>".`;
    }
    if (!input.target.startsWith("agent:")) {
      return `Invalid target "${input.target}": must be "agent:<name>"`;
    }
  }

  if (input.overlapPolicy !== undefined) {
    if (
      !SUPPORTED_OVERLAP_POLICIES.includes(
        input.overlapPolicy as "skip" | "allow",
      )
    ) {
      return `Unsupported overlap policy: "${input.overlapPolicy}". Supported: ${SUPPORTED_OVERLAP_POLICIES.join(", ")}`;
    }
  }

  return null;
}
