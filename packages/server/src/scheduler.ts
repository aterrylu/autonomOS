/**
 * Scheduler engine — manages Croner instances for schedule execution.
 *
 * Each enabled schedule gets its own Cron instance (timer-based, no polling).
 * Handles overlap policies, global concurrency limits, catch-up on startup,
 * and one-time schedule support.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, RunStatus, Schedule } from "@autonomos/core";
import { Cron } from "croner";
import { resolveClaudePath } from "./agents/runtime.js";
import { CONFIG_DIR } from "./configDir.js";
import { recordEvent } from "./memory/events.js";
import {
  appendRun,
  getSchedule,
  listSchedules,
  pruneRuns,
  saveSchedule,
} from "./schedules.js";
import { getSettings } from "./settings.js";

// ── Constants ───────────────────────────────────────────────────

const MAX_OUTPUT_BUFFER = 64 * 1024; // 64KB in-memory cap per stream
const OUTPUT_TRUNCATE_THRESHOLD = 10240; // 10KB in JSONL records

// ── State ───────────────────────────────────────────────────────

const activeJobs = new Map<string, Cron>();
const oneTimeTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface RunState {
  runId: string;
  scheduleName: string;
  startedAt: string;
  childProcess?: ChildProcess;
}

const runningRuns = new Map<string, RunState>();
const runQueue: string[] = [];

let schedulerRunning = false;

// ── Executor override (for testing) ────────────────────────────

export type ExecutorFn = (
  name: string,
  schedule: Schedule,
  runState: RunState,
) => void | Promise<void>;

let _isolatedExecutor: ExecutorFn | null = null;
let _agentExecutor: ExecutorFn | null = null;

// Dependency overrides (for testing real executor code paths)
type SpawnFn = typeof spawn;
type ResolveClaudePathFn = typeof resolveClaudePath;
type RouteMessageFn = (
  to: string,
  message: string,
  from: string,
) => Promise<string | null>;

let _spawnOverride: SpawnFn | null = null;
let _resolveClaudePathOverride: ResolveClaudePathFn | null = null;
let _routeMessageOverride: RouteMessageFn | null = null;

// ── Public API ──────────────────────────────────────────────────

export function isSchedulerRunning(): boolean {
  return schedulerRunning;
}

export function getActiveRunCount(): number {
  return runningRuns.size;
}

export function getQueuedRunCount(): number {
  return runQueue.length;
}

export function getMaxConcurrentRuns(): number {
  const settings = getSettings();
  return settings.scheduler?.maxConcurrentRuns ?? 3;
}

/**
 * Initialize the scheduler — load all schedules, create Cron instances,
 * run catch-up for missed runs. Call AFTER resumePersistedSessions().
 */
export function initScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;

  const schedules = listSchedules();
  const names = Object.keys(schedules);
  if (names.length === 0) {
    console.log("[scheduler] No schedules found");
    return;
  }

  // Crash recovery: clear stale currentRunId. A previous process may have
  // died uncleanly (SIGKILL / OOM / power loss) with a run in flight; the
  // flag stays on disk but no run is actually active. Without this, the
  // default `skip` overlap policy would silently skip every future fire.
  // Isolate per-schedule so one failing saveSchedule (disk full, perms)
  // doesn't abort recovery for the rest.
  for (const name of names) {
    const sched = schedules[name];
    if (!sched.state.currentRunId) continue;
    try {
      console.log(
        `[scheduler] Clearing stale currentRunId for "${name}" (crash recovery)`,
      );
      sched.state.currentRunId = null;
      saveSchedule(name, sched);
    } catch (err) {
      console.error(
        `[scheduler] Failed to clear stale currentRunId for "${name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`[scheduler] Loading ${names.length} schedule(s)...`);

  for (const name of names) {
    const schedule = schedules[name];
    if (!schedule.enabled) continue;

    try {
      addScheduleJob(name, schedule);
      catchUpIfNeeded(name, schedule);
    } catch (err) {
      console.error(
        `[scheduler] Failed to load "${name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[scheduler] Started with ${activeJobs.size} active job(s), ${oneTimeTimers.size} one-time timer(s)`,
  );
}

export function stopScheduler(): void {
  if (!schedulerRunning) return;
  schedulerRunning = false;

  for (const job of activeJobs.values()) job.stop();
  activeJobs.clear();

  for (const timer of oneTimeTimers.values()) clearTimeout(timer);
  oneTimeTimers.clear();

  for (const [name, run] of runningRuns) {
    // Kill child processes to avoid orphans
    if (run.childProcess && !run.childProcess.killed) {
      run.childProcess.kill("SIGTERM");
    }
    const schedule = getSchedule(name);
    if (schedule) {
      schedule.state.currentRunId = null;
      saveSchedule(name, schedule);
    }
  }
  runningRuns.clear();

  runQueue.length = 0;
  console.log("[scheduler] Stopped");
}

/**
 * Add or replace a Cron job for a schedule.
 * Used on init and when schedules are created/updated.
 */
export function addScheduleJob(name: string, schedule?: Schedule): void {
  removeScheduleJob(name);

  const sched = schedule ?? getSchedule(name);
  if (!sched?.enabled) return;

  if (sched.schedule.startsWith("once:")) {
    addOneTimeJob(name, sched);
    return;
  }

  try {
    const job = new Cron(
      sched.schedule,
      { timezone: sched.timezone || undefined },
      () => onScheduleFired(name),
    );
    activeJobs.set(name, job);

    const next = job.nextRun();
    if (next) {
      sched.state.nextRunAt = next.toISOString();
      saveSchedule(name, sched);
    }
  } catch (err) {
    console.error(
      `[scheduler] Invalid cron "${sched.schedule}" for "${name}":`,
      err instanceof Error ? err.message : err,
    );
    sched.state.nextRunAt = null;
    saveSchedule(name, sched);
  }
}

export function removeScheduleJob(name: string): void {
  const job = activeJobs.get(name);
  if (job) {
    job.stop();
    activeJobs.delete(name);
  }
  const timer = oneTimeTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    oneTimeTimers.delete(name);
  }
  // Purge from the run queue too — otherwise drainQueue will shift this
  // name off the queue, find no schedule on disk, and waste that drain
  // opportunity (drainQueue only dispatches one per completion).
  const queueIdx = runQueue.indexOf(name);
  if (queueIdx >= 0) {
    runQueue.splice(queueIdx, 1);
  }
}

/**
 * Trigger a schedule immediately (manual "Run now").
 * Respects overlap policy and concurrency limits.
 */
export function runScheduleNow(name: string): { error?: string } {
  const schedule = getSchedule(name);
  if (!schedule) return { error: `Schedule "${name}" not found` };

  return dispatchOrQueue(name, schedule);
}

// ── One-time schedules ──────────────────────────────────────────

function parseOneTimeDate(schedule: Schedule): Date | null {
  const timeStr = schedule.schedule.slice("once:".length);
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) {
    console.error(
      `[scheduler] Invalid one-time date "${timeStr}" for "${schedule.name}"`,
    );
    schedule.state.nextRunAt = null;
    saveSchedule(schedule.name, schedule);
    return null;
  }
  return d;
}

function fireAndDisableOneTime(name: string): void {
  onScheduleFired(name);
  const sched = getSchedule(name);
  if (sched) {
    sched.enabled = false;
    sched.state.nextRunAt = null;
    saveSchedule(name, sched);
  }
}

function addOneTimeJob(name: string, schedule: Schedule): void {
  const target = parseOneTimeDate(schedule);
  if (!target) return;

  // Always persist nextRunAt so the dashboard/API shows the scheduled time
  schedule.state.nextRunAt = target.toISOString();
  saveSchedule(name, schedule);

  const delayMs = target.getTime() - Date.now();

  if (delayMs <= 0) {
    // Past date — no timer needed. catchUpIfNeeded handles server-restart
    // catch-up separately. Newly created schedules with past dates won't fire.
    return;
  }

  const timer = setTimeout(() => {
    oneTimeTimers.delete(name);
    fireAndDisableOneTime(name);
  }, delayMs);

  oneTimeTimers.set(name, timer);
}

// ── Catch-up ────────────────────────────────────────────────────

function catchUpIfNeeded(name: string, schedule: Schedule): void {
  if (schedule.schedule.startsWith("once:")) {
    const target = parseOneTimeDate(schedule);
    if (target && target.getTime() <= Date.now() && schedule.enabled) {
      console.log(`[scheduler] Catch-up (one-time): "${name}"`);
      fireAndDisableOneTime(name);
    }
    return;
  }

  const job = activeJobs.get(name);
  if (!job) return;

  const prev = job.previousRun();
  if (!prev) return;

  const lastRunAt = schedule.state.lastRunAt
    ? new Date(schedule.state.lastRunAt)
    : null;

  if (!lastRunAt || prev.getTime() > lastRunAt.getTime()) {
    console.log(
      `[scheduler] Catch-up: "${name}" (missed run at ${prev.toISOString()})`,
    );
    dispatchOrQueue(name, schedule);
  }
}

// ── Fire & dispatch ─────────────────────────────────────────────

function onScheduleFired(name: string): void {
  const schedule = getSchedule(name);
  if (!schedule) return;

  dispatchOrQueue(name, schedule);
}

function dispatchOrQueue(name: string, schedule: Schedule): { error?: string } {
  // Overlap check
  if (schedule.state.currentRunId) {
    const policy = schedule.overlapPolicy ?? "skip";
    if (policy === "skip") {
      const record: RunRecord = {
        runId: randomUUID(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "skipped",
        target: schedule.target,
        durationMs: 0,
        error: "previous run still active (overlap: skip)",
        sessionId: null,
      };
      appendRun(name, record);
      return { error: "Skipped — previous run still active" };
    }
    if (policy === "queue" || policy === "cancel") {
      return { error: `Overlap policy "${policy}" is not yet supported` };
    }
    // "allow" — fall through
  }

  // Concurrency check
  const max = getMaxConcurrentRuns();
  if (runningRuns.size >= max) {
    if (!runQueue.includes(name)) {
      runQueue.push(name);
    }
    return { error: "Queued — at max concurrent runs" };
  }

  // Dispatch
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Update schedule state
  schedule.state.currentRunId = runId;
  schedule.state.lastRunAt = startedAt;
  schedule.state.lastRunStatus = "running";
  schedule.state.runCount = (schedule.state.runCount ?? 0) + 1;
  saveSchedule(name, schedule);

  // Log running entry
  const record: RunRecord = {
    runId,
    startedAt,
    completedAt: null,
    status: "running",
    target: schedule.target,
    durationMs: 0,
    error: null,
    sessionId: null,
  };
  appendRun(name, record);

  // Track
  const runState: RunState = { runId, scheduleName: name, startedAt };
  runningRuns.set(name, runState);

  recordEvent({
    type: "schedule_fired",
    summary: `schedule "${name}" fired (target=${schedule.target})`,
    refs: { schedules: [name] },
    payload: { name, runId, target: schedule.target },
  });

  // Execute based on target (use overrides if set, for testing)
  if (schedule.target === "isolated") {
    if (_isolatedExecutor) {
      _isolatedExecutor(name, schedule, runState);
    } else {
      executeIsolated(name, schedule, runState);
    }
  } else if (schedule.target.startsWith("agent:")) {
    if (_agentExecutor) {
      _agentExecutor(name, schedule, runState);
    } else {
      executeAgentSend(name, schedule, runState);
    }
  } else {
    onRunCompleted(name, {
      status: "failure",
      error: `Unknown target: "${schedule.target}"`,
    });
  }

  return {};
}

// ── Executors ───────────────────────────────────────────────────

function executeIsolated(
  name: string,
  schedule: Schedule,
  runState: RunState,
): void {
  let claudePath: string;
  try {
    claudePath = (_resolveClaudePathOverride ?? resolveClaudePath)();
  } catch (err) {
    onRunCompleted(name, {
      status: "failure",
      error: `claude binary not found: ${err instanceof Error ? err.message : err}`,
    });
    return;
  }

  const args = ["-p", schedule.prompt, "--output-format", "text"];
  if (schedule.autonomous !== false) {
    args.push("--dangerously-skip-permissions");
  }

  const home = process.env.HOME;
  const cwd = home
    ? schedule.workingDirectory.replace(/^~/, home)
    : schedule.workingDirectory;

  if (!cwd || cwd.startsWith("~")) {
    onRunCompleted(name, {
      status: "failure",
      error: `Cannot resolve working directory "${schedule.workingDirectory}" — HOME is not set`,
    });
    return;
  }

  const spawnFn = _spawnOverride ?? spawn;
  const child = spawnFn(claudePath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  runState.childProcess = child;

  let stdout = "";
  let stderr = "";
  let completed = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length < MAX_OUTPUT_BUFFER) stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_OUTPUT_BUFFER) stderr += chunk.toString();
  });

  child.on("error", (err) => {
    if (completed) return;
    completed = true;
    onRunCompleted(name, {
      status: "failure",
      error: err.message,
      output: stderr || undefined,
    });
  });

  child.on("close", (code) => {
    if (completed) return;
    completed = true;

    const output = stdout || stderr || undefined;
    const truncatedOutput =
      output && output.length > OUTPUT_TRUNCATE_THRESHOLD
        ? `${output.slice(0, OUTPUT_TRUNCATE_THRESHOLD)}\n... (truncated)`
        : output;

    if (output && output.length > OUTPUT_TRUNCATE_THRESHOLD) {
      try {
        const outDir = join(CONFIG_DIR, "schedule-runs", name);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${runState.runId}.out`), output, {
          mode: 0o600,
        });
      } catch (err) {
        console.error(
          `[scheduler] Failed to write output for "${name}" run ${runState.runId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (code === 0) {
      onRunCompleted(name, { status: "success", output: truncatedOutput });
    } else {
      onRunCompleted(name, {
        status: "failure",
        error: `Exit code ${code}`,
        output: truncatedOutput,
      });
    }
  });
}

async function executeAgentSend(
  name: string,
  schedule: Schedule,
  _runState: RunState,
): Promise<void> {
  try {
    let routeMsg: RouteMessageFn;
    if (_routeMessageOverride) {
      routeMsg = _routeMessageOverride;
    } else {
      const { routeMessage } = await import("./gateway/router.js");
      routeMsg = routeMessage;
    }
    const agentName = schedule.target.slice("agent:".length);
    const to = `agent://${agentName}`;

    const error = await routeMsg(to, schedule.prompt, "scheduler");
    if (error) {
      onRunCompleted(name, { status: "failure", error });
    } else {
      onRunCompleted(name, { status: "success" });
    }
  } catch (err) {
    onRunCompleted(name, {
      status: "failure",
      error: `Gateway error: ${err instanceof Error ? err.message : err}`,
    });
  }
}

// ── Run completion ──────────────────────────────────────────────

interface RunResult {
  status: RunStatus;
  error?: string;
  output?: string;
  sessionId?: string;
}

function onRunCompleted(name: string, result: RunResult): void {
  const run = runningRuns.get(name);
  if (!run) {
    // Safety: clear stale currentRunId even if we lost track of the run
    const schedule = getSchedule(name);
    if (schedule?.state.currentRunId) {
      schedule.state.currentRunId = null;
      saveSchedule(name, schedule);
    }
    return;
  }

  runningRuns.delete(name);

  const now = new Date().toISOString();
  const durationMs = Date.now() - new Date(run.startedAt).getTime();

  const record: RunRecord = {
    runId: run.runId,
    startedAt: run.startedAt,
    completedAt: now,
    status: result.status,
    target: getSchedule(name)?.target ?? "unknown",
    durationMs,
    error: result.error ?? null,
    sessionId: result.sessionId ?? null,
    output: result.output,
  };
  appendRun(name, record);

  const schedule = getSchedule(name);
  if (schedule) {
    schedule.state.currentRunId = null;
    schedule.state.lastRunStatus = result.status;
    schedule.state.consecutiveFailures =
      result.status === "success"
        ? 0
        : (schedule.state.consecutiveFailures ?? 0) + 1;

    const job = activeJobs.get(name);
    if (job) {
      const next = job.nextRun();
      schedule.state.nextRunAt = next ? next.toISOString() : null;
    }

    saveSchedule(name, schedule);
  }

  if (schedule?.onComplete && schedule.target === "isolated") {
    deliverOnComplete(schedule.onComplete, name, result).catch((err) => {
      console.error(
        `[scheduler] onComplete delivery failed for "${name}":`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  recordEvent({
    type: "schedule_completed",
    summary: `schedule "${name}" completed: ${result.status}${
      result.error ? ` — ${result.error}` : ""
    }`,
    refs: { schedules: [name] },
    payload: {
      name,
      runId: run.runId,
      status: result.status,
      durationMs,
      error: result.error,
    },
  });

  pruneRuns(name);
  drainQueue();
}

async function deliverOnComplete(
  uri: string,
  name: string,
  result: RunResult,
): Promise<void> {
  let routeMsg: RouteMessageFn;
  if (_routeMessageOverride) {
    routeMsg = _routeMessageOverride;
  } else {
    const { routeMessage } = await import("./gateway/router.js");
    routeMsg = routeMessage;
  }
  const summary = `Schedule "${name}" completed: ${result.status}${result.error ? ` — ${result.error}` : ""}`;
  await routeMsg(uri, summary, "scheduler");
}

function drainQueue(): void {
  if (runQueue.length === 0) return;
  const max = getMaxConcurrentRuns();
  if (runningRuns.size >= max) return;

  const next = runQueue.shift();
  if (!next) return;

  const schedule = getSchedule(next);
  if (schedule) {
    dispatchOrQueue(next, schedule);
  }
}

// ── Test utilities ─────────────────────────────────────────────

export function _resetForTesting(): void {
  stopScheduler();
  schedulerRunning = false;
  _isolatedExecutor = null;
  _agentExecutor = null;
  _spawnOverride = null;
  _resolveClaudePathOverride = null;
  _routeMessageOverride = null;
}

export function _setExecutors(
  isolated: ExecutorFn | null,
  agent: ExecutorFn | null,
): void {
  _isolatedExecutor = isolated;
  _agentExecutor = agent;
}

export function _setDependencies(deps: {
  spawn?: SpawnFn | null;
  resolveClaudePath?: ResolveClaudePathFn | null;
  routeMessage?: RouteMessageFn | null;
}): void {
  if ("spawn" in deps) _spawnOverride = deps.spawn ?? null;
  if ("resolveClaudePath" in deps)
    _resolveClaudePathOverride = deps.resolveClaudePath ?? null;
  if ("routeMessage" in deps) _routeMessageOverride = deps.routeMessage ?? null;
}

export { onRunCompleted as _onRunCompleted };
