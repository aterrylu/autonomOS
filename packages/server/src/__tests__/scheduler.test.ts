import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Schedule, ScheduleConfig } from "@autonomos/core";

// ── Test isolation ─────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `autonomos-sched-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { createSchedule, getSchedule, saveSchedule, getRecentRuns } =
  await import("../schedules.js");

const {
  initScheduler,
  stopScheduler,
  addScheduleJob,
  removeScheduleJob,
  runScheduleNow,
  isSchedulerRunning,
  getActiveRunCount,
  getQueuedRunCount,
  _resetForTesting,
  _setExecutors,
  _onRunCompleted,
} = await import("../scheduler.js");

const SCHEDULES_DIR = join(TEST_DIR, "schedules");

function makeSchedule(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    name: `sched-${randomUUID().slice(0, 8)}`,
    schedule: "0 9 * * 1-5",
    target: "isolated",
    prompt: "Run daily standup",
    workingDirectory: "~/workspace",
    enabled: true,
    ...overrides,
  };
}

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  // Create a settings.json so getSettings() works
  writeFileSync(
    join(TEST_DIR, "settings.json"),
    JSON.stringify({ scheduler: { maxConcurrentRuns: 3 } }),
  );
}

describe("scheduler engine", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── initScheduler / stopScheduler ──────────────────────────

  describe("init and stop", () => {
    it("starts with no schedules (no error)", () => {
      initScheduler();
      assert.ok(isSchedulerRunning());
    });

    it("loads enabled schedules as Cron jobs", () => {
      createSchedule(makeSchedule({ name: "enabled-one" }));
      createSchedule(makeSchedule({ name: "disabled-one", enabled: false }));

      initScheduler();
      assert.ok(isSchedulerRunning());
    });

    it("is idempotent — double init does not throw", () => {
      initScheduler();
      initScheduler();
      assert.ok(isSchedulerRunning());
    });

    it("stopScheduler clears state", () => {
      createSchedule(makeSchedule({ name: "to-stop" }));
      initScheduler();
      stopScheduler();

      assert.ok(!isSchedulerRunning());
      assert.equal(getActiveRunCount(), 0);
      assert.equal(getQueuedRunCount(), 0);
    });
  });

  // ── Overlap policies ───────────────────────────────────────

  describe("overlap policy: skip", () => {
    it("skips when a run is already active", () => {
      const config = makeSchedule({
        name: "skip-overlap",
        overlapPolicy: "skip",
      });
      const schedule = createSchedule(config);

      // Simulate an active run
      schedule.state.currentRunId = "active-run-id";
      saveSchedule("skip-overlap", schedule);

      // Set a mock executor that should NOT be called
      let executorCalled = false;
      _setExecutors(() => {
        executorCalled = true;
      }, null);

      initScheduler();
      const result = runScheduleNow("skip-overlap");

      assert.ok(result.error?.includes("Skipped"));
      assert.ok(
        !executorCalled,
        "executor should not be called for skipped run",
      );

      // Should have a "skipped" run record
      const runs = getRecentRuns("skip-overlap", 10);
      assert.ok(runs.some((r) => r.status === "skipped"));
    });
  });

  describe("overlap policy: allow", () => {
    it("dispatches even when a run is active", () => {
      const config = makeSchedule({
        name: "allow-overlap",
        overlapPolicy: "allow",
      });
      const schedule = createSchedule(config);

      schedule.state.currentRunId = "active-run-id";
      saveSchedule("allow-overlap", schedule);

      let executorCalled = false;
      _setExecutors((_name, _schedule, _runState) => {
        executorCalled = true;
        // Simulate immediate completion
        _onRunCompleted(_name, { status: "success" });
      }, null);

      initScheduler();
      const result = runScheduleNow("allow-overlap");

      assert.equal(result.error, undefined);
      assert.ok(executorCalled, "executor should be called with allow policy");
    });
  });

  describe("overlap policy: queue/cancel (unsupported)", () => {
    it("returns error for queue policy", () => {
      const config = makeSchedule({
        name: "queue-policy",
        overlapPolicy: "queue",
      });
      const schedule = createSchedule(config);
      schedule.state.currentRunId = "active-run-id";
      saveSchedule("queue-policy", schedule);

      initScheduler();
      const result = runScheduleNow("queue-policy");
      assert.ok(result.error?.includes("not yet supported"));
    });
  });

  // ── Concurrency limits ─────────────────────────────────────

  describe("concurrency", () => {
    it("queues when at max concurrent runs", () => {
      // Create 4 schedules, max concurrent is 3
      for (let i = 0; i < 4; i++) {
        createSchedule(makeSchedule({ name: `conc-${i}` }));
      }

      // Mock executor that never completes (simulates long-running)
      _setExecutors(() => {}, null);

      initScheduler();

      // Dispatch 3 — should all succeed
      for (let i = 0; i < 3; i++) {
        const result = runScheduleNow(`conc-${i}`);
        assert.equal(result.error, undefined, `conc-${i} should dispatch`);
      }

      assert.equal(getActiveRunCount(), 3);

      // 4th should be queued
      const result = runScheduleNow("conc-3");
      assert.ok(result.error?.includes("Queued"));
      assert.equal(getQueuedRunCount(), 1);
    });

    it("drains queue when a run completes", () => {
      for (let i = 0; i < 4; i++) {
        createSchedule(makeSchedule({ name: `drain-${i}` }));
      }

      const executorCalls: string[] = [];
      _setExecutors((name) => {
        executorCalls.push(name);
      }, null);

      initScheduler();

      // Fill to capacity
      for (let i = 0; i < 3; i++) {
        runScheduleNow(`drain-${i}`);
      }
      // Queue the 4th
      runScheduleNow("drain-3");
      assert.equal(getQueuedRunCount(), 1);

      // Complete first run — should drain queue
      _onRunCompleted("drain-0", { status: "success" });

      assert.equal(getQueuedRunCount(), 0);
      assert.ok(
        executorCalls.includes("drain-3"),
        "queued run should be dispatched",
      );
    });
  });

  // ── Isolated execution dispatch ────────────────────────────

  describe("isolated execution", () => {
    it("dispatches to isolated executor with correct args", () => {
      const config = makeSchedule({
        name: "iso-test",
        target: "isolated",
        prompt: "Run tests please",
      });
      createSchedule(config);

      let capturedArgs: { name: string; schedule: Schedule } | null = null;
      _setExecutors((name, schedule) => {
        capturedArgs = { name, schedule };
        _onRunCompleted(name, { status: "success" });
      }, null);

      initScheduler();
      const result = runScheduleNow("iso-test");

      assert.equal(result.error, undefined);
      assert.ok(capturedArgs);
      const isoArgs = capturedArgs as { name: string; schedule: Schedule };
      assert.equal(isoArgs.name, "iso-test");
      assert.equal(isoArgs.schedule.prompt, "Run tests please");
      assert.equal(isoArgs.schedule.target, "isolated");
    });

    it("records success in run history", () => {
      createSchedule(makeSchedule({ name: "iso-success" }));
      _setExecutors((name) => {
        _onRunCompleted(name, { status: "success", output: "done" });
      }, null);

      initScheduler();
      runScheduleNow("iso-success");

      const runs = getRecentRuns("iso-success", 10);
      // Should have: running record + success record
      const successRun = runs.find((r) => r.status === "success");
      assert.ok(successRun, "should have success record");
      assert.ok(successRun!.completedAt);
      assert.ok(successRun!.durationMs >= 0);
    });

    it("records failure in run history", () => {
      createSchedule(makeSchedule({ name: "iso-fail" }));
      _setExecutors((name) => {
        _onRunCompleted(name, { status: "failure", error: "Exit code 1" });
      }, null);

      initScheduler();
      runScheduleNow("iso-fail");

      const runs = getRecentRuns("iso-fail", 10);
      const failRun = runs.find((r) => r.status === "failure");
      assert.ok(failRun);
      assert.equal(failRun!.error, "Exit code 1");
    });

    it("updates schedule state on completion", () => {
      createSchedule(makeSchedule({ name: "state-update" }));
      _setExecutors((name) => {
        _onRunCompleted(name, { status: "success" });
      }, null);

      initScheduler();
      runScheduleNow("state-update");

      const schedule = getSchedule("state-update");
      assert.ok(schedule);
      assert.equal(schedule.state.currentRunId, null);
      assert.equal(schedule.state.lastRunStatus, "success");
      assert.equal(schedule.state.runCount, 1);
      assert.equal(schedule.state.consecutiveFailures, 0);
    });

    it("increments consecutiveFailures on failure", () => {
      createSchedule(makeSchedule({ name: "fail-count" }));
      _setExecutors((name) => {
        _onRunCompleted(name, { status: "failure", error: "oops" });
      }, null);

      initScheduler();

      runScheduleNow("fail-count");
      let schedule = getSchedule("fail-count");
      assert.equal(schedule!.state.consecutiveFailures, 1);

      // Run again
      runScheduleNow("fail-count");
      schedule = getSchedule("fail-count");
      assert.equal(schedule!.state.consecutiveFailures, 2);
    });

    it("resets consecutiveFailures on success", () => {
      createSchedule(makeSchedule({ name: "fail-reset" }));

      let failMode = true;
      _setExecutors((name) => {
        _onRunCompleted(
          name,
          failMode
            ? { status: "failure", error: "oops" }
            : { status: "success" },
        );
      }, null);

      initScheduler();

      // Fail twice
      runScheduleNow("fail-reset");
      runScheduleNow("fail-reset");

      let schedule = getSchedule("fail-reset");
      assert.equal(schedule!.state.consecutiveFailures, 2);

      // Succeed once
      failMode = false;
      runScheduleNow("fail-reset");

      schedule = getSchedule("fail-reset");
      assert.equal(schedule!.state.consecutiveFailures, 0);
    });
  });

  // ── Agent execution dispatch ───────────────────────────────

  describe("agent execution", () => {
    it("dispatches to agent executor with correct args", () => {
      const config = makeSchedule({
        name: "agent-test",
        target: "agent:my-worker",
        prompt: "Do the thing",
      });
      createSchedule(config);

      let capturedArgs: { name: string; schedule: Schedule } | null = null;
      _setExecutors(null, (name, schedule) => {
        capturedArgs = { name, schedule };
        _onRunCompleted(name, { status: "success" });
      });

      initScheduler();
      const result = runScheduleNow("agent-test");

      assert.equal(result.error, undefined);
      assert.ok(capturedArgs);
      const agentArgs = capturedArgs as { name: string; schedule: Schedule };
      assert.equal(agentArgs.name, "agent-test");
      assert.equal(agentArgs.schedule.target, "agent:my-worker");
      assert.equal(agentArgs.schedule.prompt, "Do the thing");
    });

    it("records run history for agent mode", () => {
      createSchedule(
        makeSchedule({ name: "agent-history", target: "agent:reporter" }),
      );
      _setExecutors(null, (name) => {
        _onRunCompleted(name, { status: "success" });
      });

      initScheduler();
      runScheduleNow("agent-history");

      const runs = getRecentRuns("agent-history", 10);
      assert.ok(runs.length >= 1);
      const successRun = runs.find((r) => r.status === "success");
      assert.ok(successRun);
    });
  });

  // ── Unknown target ─────────────────────────────────────────

  describe("unknown target", () => {
    it("fails immediately for unknown target type", () => {
      createSchedule(
        makeSchedule({ name: "bad-target", target: "webhook:foo" }),
      );
      // No executors set — will hit the else branch
      _setExecutors(null, null);

      initScheduler();
      runScheduleNow("bad-target");

      const runs = getRecentRuns("bad-target", 10);
      const failRun = runs.find((r) => r.status === "failure");
      assert.ok(failRun);
      assert.ok(failRun!.error?.includes("Unknown target"));
    });
  });

  // ── runScheduleNow ─────────────────────────────────────────

  describe("runScheduleNow", () => {
    it("returns error for non-existent schedule", () => {
      initScheduler();
      const result = runScheduleNow("does-not-exist");
      assert.ok(result.error?.includes("not found"));
    });

    it("sets currentRunId during execution", () => {
      createSchedule(makeSchedule({ name: "current-run" }));

      let midRunState: Schedule | null = null;
      _setExecutors((name) => {
        // Check state mid-execution
        midRunState = getSchedule(name);
        _onRunCompleted(name, { status: "success" });
      }, null);

      initScheduler();
      runScheduleNow("current-run");

      assert.ok(midRunState);
      const runState = midRunState as Schedule;
      assert.ok(
        runState.state.currentRunId,
        "currentRunId should be set during run",
      );
    });

    it("clears currentRunId after completion", () => {
      createSchedule(makeSchedule({ name: "cleared-run" }));
      _setExecutors((name) => {
        _onRunCompleted(name, { status: "success" });
      }, null);

      initScheduler();
      runScheduleNow("cleared-run");

      const schedule = getSchedule("cleared-run");
      assert.equal(schedule!.state.currentRunId, null);
    });
  });

  // ── One-time schedules ─────────────────────────────────────

  describe("one-time schedules", () => {
    it("sets up timer for future one-time schedule", () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      createSchedule(
        makeSchedule({
          name: "one-time-future",
          schedule: `once:${futureDate}`,
        }),
      );

      initScheduler();

      const schedule = getSchedule("one-time-future");
      assert.ok(schedule);
      assert.ok(schedule!.state.nextRunAt);
    });

    it("ignores past one-time schedule with catch-up disabled by default behavior", () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      createSchedule(
        makeSchedule({
          name: "one-time-past",
          schedule: `once:${pastDate}`,
        }),
      );

      // The past one-time schedule triggers catch-up
      let executorCalled = false;
      _setExecutors(() => {
        executorCalled = true;
      }, null);

      initScheduler();
      // Catch-up should have fired for the missed one-time
      assert.ok(executorCalled, "catch-up should fire for past one-time");
    });

    it("handles invalid one-time date gracefully", () => {
      createSchedule(
        makeSchedule({
          name: "one-time-bad",
          schedule: "once:not-a-date",
        }),
      );

      // Should not throw
      initScheduler();

      const schedule = getSchedule("one-time-bad");
      assert.ok(schedule);
      assert.equal(schedule!.state.nextRunAt, null);
    });
  });

  // ── addScheduleJob / removeScheduleJob ─────────────────────

  describe("job management", () => {
    it("addScheduleJob does nothing for disabled schedule", () => {
      createSchedule(makeSchedule({ name: "disabled-job", enabled: false }));

      initScheduler();
      addScheduleJob("disabled-job");

      // Should not throw, job simply not added
    });

    it("removeScheduleJob cleans up without error", () => {
      createSchedule(makeSchedule({ name: "removable" }));
      initScheduler();
      addScheduleJob("removable");

      // Should not throw
      removeScheduleJob("removable");
      removeScheduleJob("removable"); // idempotent
    });

    it("handles invalid cron expression gracefully", () => {
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      const badSchedule: Schedule = {
        name: "bad-cron",
        schedule: "not a cron",
        target: "isolated",
        prompt: "test",
        workingDirectory: "~",
        enabled: true,
        state: {
          lastRunAt: null,
          lastRunStatus: null,
          nextRunAt: null,
          runCount: 0,
          consecutiveFailures: 0,
          currentRunId: null,
        },
      };
      saveSchedule("bad-cron", badSchedule);

      initScheduler();

      // Should not throw, but nextRunAt should be null
      const schedule = getSchedule("bad-cron");
      assert.equal(schedule!.state.nextRunAt, null);
    });
  });
});
