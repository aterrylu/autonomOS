/**
 * Schedule types — cron-based task scheduling for autonomOS agents.
 *
 * Schedules are created by agents via MCP tools, stored as individual
 * JSON files in ~/.autonomos/schedules/<name>.json.
 */

// ── Overlap Policies ────────────────────────────────────────────

/** What to do when a schedule fires while a previous run is active */
export type OverlapPolicy = "skip" | "allow" | "queue" | "cancel";

/** Policies implemented in v1 */
export const SUPPORTED_OVERLAP_POLICIES: OverlapPolicy[] = ["skip", "allow"];

// ── Notification Policies ───────────────────────────────────────

export type NotifyPolicy = "always" | "failure" | "never";

// ── Run Status ──────────────────────────────────────────────────

export type RunStatus = "success" | "failure" | "skipped" | "running";

// ── Schedule State (server-managed) ─────────────────────────────

export interface ScheduleState {
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  nextRunAt: string | null;
  runCount: number;
  consecutiveFailures: number;
  currentRunId: string | null;
}

// ── Schedule Config (agent-editable) ────────────────────────────

export interface ScheduleConfig {
  name: string;
  description?: string;
  schedule: string;
  timezone?: string;
  target: string;
  prompt: string;
  template?: string;
  workingDirectory: string;
  autonomous?: boolean;
  overlapPolicy?: OverlapPolicy;
  onComplete?: string;
  notify?: NotifyPolicy;
  enabled: boolean;
}

// ── Full Schedule (config + state, as stored on disk) ───────────

export interface Schedule extends ScheduleConfig {
  state: ScheduleState;
}

// ── Run Record (one JSONL line in schedule-runs/<name>.jsonl) ────

export interface RunRecord {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: RunStatus;
  target: string;
  durationMs: number;
  error: string | null;
  sessionId: string | null;
  output?: string;
}

// ── Scheduler Status (global runtime state) ─────────────────────

export interface SchedulerStatus {
  running: boolean;
  maxConcurrentRuns: number;
  activeRuns: number;
  queuedRuns: number;
}
