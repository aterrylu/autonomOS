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
  /** Delivery target. Only `agent:<name>` is supported — a schedule sends its
   *  prompt to an already-running agent. The former `isolated` target (headless
   *  `claude -p`) was removed; see the scheduler ADR. */
  target: string;
  prompt: string;

  // ── Accepted and ignored (see the scheduler ADR) ───────────────
  //
  // These existed only to configure the removed `isolated` executor, as does
  // `onComplete` further down. They are kept in the type rather than deleted
  // so a schedule file — or an MCP client — written before the removal still
  // LOADS instead of failing validation. They have no effect. Same
  // accept-and-discard shape as `capabilities` (ADR-058) and `autonomousMode`
  // (ADR-045).
  //
  // If you are looking for how much autonomy a scheduled run has: it is the
  // receiving agent's own `permissionMode`. A schedule cannot change it, which
  // is the point — the removed executor was the one spawn path in the product
  // that sat outside PermissionMode and defaulted to skipping all prompts.

  /** @deprecated No effect. `isolated` never read it; nothing does now. */
  template?: string;
  /** @deprecated No effect. Was the cwd of the headless child; an `agent:`
   *  target runs in the receiving agent's own working directory.
   *  Optional as of the removal — it used to be required. */
  workingDirectory?: string;
  /** @deprecated No effect. Was `--dangerously-skip-permissions` on the
   *  headless child, defaulting to ON. Autonomy is now the receiving agent's
   *  `permissionMode`. */
  autonomous?: boolean;

  overlapPolicy?: OverlapPolicy;
  /** @deprecated No effect — the delivery code is deleted, not merely gated.
   *
   *  It fired only for `isolated` runs, where "completed" meant the child
   *  process had exited. For an `agent:` target a run completes when the prompt
   *  is DELIVERED — the agent has not started — so rehoming it would announce a
   *  completion that has not happened. Reporting real agent-side completion
   *  needs the agent to signal back; that is a different feature.
   *
   *  Left gated on the dead target instead of deleted, it was NOT inert: an
   *  `isolated` schedule still on disk satisfied the gate, so an enabled
   *  recurring one would have fired a gateway message on every tick forever
   *  while five other places called the field a no-op. See ADR-062. */
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
  /** @deprecated Never written for new runs. Held the headless child's stdout;
   *  an `agent:` run produces no output here — the work happens in the agent's
   *  own session. Kept so historical JSONL records still parse and render. */
  output?: string;
}

// ── Scheduler Status (global runtime state) ─────────────────────

export interface SchedulerStatus {
  running: boolean;
  maxConcurrentRuns: number;
  activeRuns: number;
  queuedRuns: number;
}
