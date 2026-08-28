/**
 * Scheduler engine — manages Croner instances for schedule execution.
 *
 * Each enabled schedule gets its own Cron instance (timer-based, no polling).
 * Handles overlap policies, global concurrency limits, catch-up on startup,
 * and one-time schedule support.
 */

import { randomUUID } from "node:crypto";
import type { RunRecord, RunStatus, Schedule } from "@autonomos/core";
import { Cron } from "croner";
import {
  appendRun,
  getSchedule,
  listSchedules,
  pruneRuns,
  saveSchedule,
} from "./schedules.js";
import { getSettings } from "./settings.js";

// ── State ───────────────────────────────────────────────────────

const activeJobs = new Map<string, Cron>();
const oneTimeTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface RunState {
  runId: string;
  scheduleName: string;
  startedAt: string;
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

let _agentExecutor: ExecutorFn | null = null;

// Dependency overrides (for testing real executor code paths)
type RouteMessageFn = (
  to: string,
  message: string,
  from: string,
) => Promise<string | null>;

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

  // Surface schedules still pointing at the removed `isolated` target. They
  // load fine (nothing validates on read) and stay editable, but they can
  // never run again.
  //
  // Reported here rather than left to fail on the next fire, because a
  // DISABLED one has no next fire — nothing would ever mention it. Scoped
  // honestly: this is a log line, and it lands in $configDir/logs/autonomos.log
  // rather than the UI. SchedulesPanel still renders `isolated` as ordinary
  // target text, so the panel alone still cannot distinguish dormant from
  // broken. Surfacing it there is a separate change.
  //
  // One carve-out: a one-time schedule that already fired SUCCESSFULLY and
  // self-disabled is a completed historical artifact, not dormant intent —
  // there is nothing to repoint or re-enable, so nagging about it every boot
  // is pure noise (2026-08-08 audit: the only live instance was exactly
  // this). lastRunStatus matters, not just runCount: runCount increments at
  // DISPATCH, so a one-time isolated schedule consumed by the immediate
  // "target removed" failure has runCount=1 while its work never ran — that
  // one must stay warned.
  const orphaned = names.filter((n) => {
    const s = schedules[n];
    if (s.target !== "isolated") return false;
    const completedOneTime =
      !s.enabled &&
      s.schedule.startsWith("once:") &&
      (s.state.runCount ?? 0) > 0 &&
      s.state.lastRunStatus === "success";
    return !completedOneTime;
  });
  if (orphaned.length > 0) {
    console.warn(
      `[scheduler] ${orphaned.length} schedule(s) target the removed "isolated" mode ` +
        `and cannot run: ${orphaned.join(", ")}. Point each at a running agent ` +
        `("agent:<name>") or delete it.`,
    );
  }

  // PR C reserved "status"/"settings" as schedule names (the scheduler-control
  // routes own those paths under /api/schedules). The create guard only stops
  // NEW ones — a pre-rename schedule with a reserved name still loads and
  // still FIRES, but its detail routes (GET/PUT/DELETE /api/schedules/<name>)
  // are shadowed by the control routes, so it can no longer be inspected or
  // edited over REST. Same reporting rationale as the isolated warn above.
  const shadowed = names.filter((n) => n === "status" || n === "settings");
  if (shadowed.length > 0) {
    console.warn(
      `[scheduler] ${shadowed.length} schedule(s) use a name reserved by the ` +
        `scheduler-control routes and cannot be managed over REST: ` +
        `${shadowed.join(", ")}. Rename each (delete + recreate under a new ` +
        `name) — the schedule still fires, but the dashboard cannot show it.`,
    );
  }

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

  // No child processes to reap: every run is now a gateway message to an
  // already-running agent, which owns its own lifecycle.
  for (const [name] of runningRuns) {
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

/** setTimeout's delay is a 32-bit signed int (~24.86 days). Node CLAMPS an
 *  overflowing delay to 1ms, so before this guard a one-time schedule more
 *  than ~25 days out fired IMMEDIATELY and then disabled itself — the
 *  scheduled intent was silently consumed months early (observed live: two
 *  far-future relay schedules ran instantly at creation, with matching
 *  TimeoutOverflowWarnings in the log). */
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

function addOneTimeJob(name: string, schedule: Schedule): void {
  const target = parseOneTimeDate(schedule);
  if (!target) return;

  // Always persist nextRunAt so the dashboard/API shows the scheduled time
  schedule.state.nextRunAt = target.toISOString();
  saveSchedule(name, schedule);

  const targetMs = target.getTime();
  if (targetMs <= Date.now()) {
    // Past date at arm time — no timer. catchUpIfNeeded handles server-restart
    // catch-up separately. Newly created schedules with past dates won't fire.
    return;
  }

  armOneTimeTimer(name, targetMs);
}

/** Arm (or re-arm) the fire timer for a one-time schedule, chaining through
 *  int32-sized hops for far-future targets. Recomputes the remaining delay at
 *  every hop; a target the clock has already passed at a hop (e.g. the host
 *  slept through it) fires immediately — same behavior a single overflow-free
 *  setTimeout would have had. */
function armOneTimeTimer(name: string, targetMs: number): void {
  const delayMs = targetMs - Date.now();

  if (delayMs > MAX_TIMEOUT_DELAY_MS) {
    const timer = setTimeout(
      () => armOneTimeTimer(name, targetMs),
      MAX_TIMEOUT_DELAY_MS,
    );
    oneTimeTimers.set(name, timer);
    return;
  }

  const timer = setTimeout(
    () => {
      oneTimeTimers.delete(name);
      fireAndDisableOneTime(name);
    },
    Math.max(delayMs, 0),
  );
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

  // Execute based on target (use overrides if set, for testing).
  //
  // `agent:<name>` is the ONLY target. The former `isolated` target spawned a
  // headless `claude -p` child; it was removed because it was the one spawn
  // path in the product that lived outside PermissionMode entirely, defaulting
  // to --dangerously-skip-permissions. See the scheduler ADR.
  if (schedule.target.startsWith("agent:")) {
    if (_agentExecutor) {
      _agentExecutor(name, schedule, runState);
    } else {
      executeAgentSend(name, schedule, runState);
    }
  } else {
    // Names the removed target specifically when that's what was asked for —
    // a bare "unknown target" would leave an operator with a pre-existing
    // schedule guessing why it stopped.
    onRunCompleted(name, {
      status: "failure",
      error:
        schedule.target === "isolated"
          ? `The "isolated" target was removed — schedules now message a running agent. ` +
            `Change "${name}" to target "agent:<name>".`
          : `Unknown target: "${schedule.target}"`,
    });
  }

  return {};
}

// ── Executors ───────────────────────────────────────────────────

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

    // Sender id `schedule:<name>` (mirrors the `agent:<name>` target
    // convention): the router renders it as "Schedule <name>" with from_uri
    // schedule://<name>, so the receiving agent knows WHICH schedule fired —
    // and a reply attempt gets the schedule-scheme guidance instead of
    // hunting for a phantom "Scheduler" agent.
    const error = await routeMsg(to, schedule.prompt, `schedule:${name}`);
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

  pruneRuns(name);
  drainQueue();
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
  _agentExecutor = null;
  _routeMessageOverride = null;
}

export function _setExecutors(agent: ExecutorFn | null): void {
  _agentExecutor = agent;
}

export function _setDependencies(deps: {
  routeMessage?: RouteMessageFn | null;
}): void {
  if ("routeMessage" in deps) _routeMessageOverride = deps.routeMessage ?? null;
}

export { onRunCompleted as _onRunCompleted };
