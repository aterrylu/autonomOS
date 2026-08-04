import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { RunRecord, Schedule, ScheduleConfig } from "@autonomos/core";

// ── Test isolation ─────────────────────────────────────────────
// schedules.ts reads CONFIG_DIR at import time from configDir.ts,
// which uses AUTONOMOS_CONFIG_DIR. We set it before importing.
const TEST_DIR = join(tmpdir(), `autonomos-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

// Dynamic import so CONFIG_DIR picks up our test directory
const {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  saveSchedule,
  updateSchedule,
  validateScheduleInput,
  appendRun,
  getRecentRuns,
  pruneRuns,
} = await import("../schedules.js");

const SCHEDULES_DIR = join(TEST_DIR, "schedules");
const RUNS_DIR = join(TEST_DIR, "schedule-runs");

function makeConfig(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    name: `test-${randomUUID().slice(0, 8)}`,
    schedule: "0 9 * * 1-5",
    target: "agent:worker",
    prompt: "Run daily standup",
    workingDirectory: "~/workspace",
    enabled: true,
    ...overrides,
  };
}

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "success",
    target: "agent:worker",
    durationMs: 1234,
    error: null,
    sessionId: null,
    ...overrides,
  };
}

describe("schedules CRUD", () => {
  beforeEach(() => {
    // Clean and recreate test dirs
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Name validation ────────────────────────────────────────

  describe("name validation", () => {
    it("rejects names with uppercase", () => {
      assert.throws(
        () => createSchedule(makeConfig({ name: "MySchedule" })),
        /Invalid schedule name/,
      );
    });

    it("rejects names with spaces", () => {
      assert.throws(
        () => createSchedule(makeConfig({ name: "my schedule" })),
        /Invalid schedule name/,
      );
    });

    it("rejects names starting with hyphen", () => {
      assert.throws(
        () => createSchedule(makeConfig({ name: "-bad-name" })),
        /Invalid schedule name/,
      );
    });

    it("rejects names with path traversal", () => {
      assert.throws(
        () => createSchedule(makeConfig({ name: "../etc/passwd" as string })),
        /Invalid schedule name/,
      );
    });

    it("rejects empty name", () => {
      assert.throws(
        () => createSchedule(makeConfig({ name: "" })),
        /Invalid schedule name/,
      );
    });

    it("accepts valid names with digits and hyphens", () => {
      const config = makeConfig({ name: "daily-report-v2" });
      const created = createSchedule(config);
      assert.equal(created.name, "daily-report-v2");
    });
  });

  // ── createSchedule ─────────────────────────────────────────

  describe("createSchedule", () => {
    it("creates a schedule file on disk", () => {
      const config = makeConfig({ name: "my-schedule" });
      const schedule = createSchedule(config);

      assert.equal(schedule.name, "my-schedule");
      assert.equal(schedule.schedule, config.schedule);
      assert.equal(schedule.target, "agent:worker");
      assert.equal(schedule.prompt, config.prompt);

      // File should exist
      const filePath = join(SCHEDULES_DIR, "my-schedule.json");
      assert.ok(existsSync(filePath), "schedule file should exist");
    });

    it("initializes state with defaults", () => {
      const schedule = createSchedule(makeConfig({ name: "with-state" }));

      assert.equal(schedule.state.lastRunAt, null);
      assert.equal(schedule.state.lastRunStatus, null);
      assert.equal(schedule.state.nextRunAt, null);
      assert.equal(schedule.state.runCount, 0);
      assert.equal(schedule.state.consecutiveFailures, 0);
      assert.equal(schedule.state.currentRunId, null);
    });

    it("throws on duplicate name", () => {
      const config = makeConfig({ name: "unique-name" });
      createSchedule(config);
      assert.throws(() => createSchedule(config), /already exists/);
    });

    it("preserves all config fields", () => {
      const config = makeConfig({
        name: "full-config",
        description: "A test schedule",
        timezone: "America/New_York",
        template: "my-template",
        autonomous: false,
        overlapPolicy: "allow",
        onComplete: "agent://reporter",
        notify: "failure",
      });
      const schedule = createSchedule(config);

      assert.equal(schedule.description, "A test schedule");
      assert.equal(schedule.timezone, "America/New_York");
      assert.equal(schedule.template, "my-template");
      assert.equal(schedule.autonomous, false);
      assert.equal(schedule.overlapPolicy, "allow");
      assert.equal(schedule.onComplete, "agent://reporter");
      assert.equal(schedule.notify, "failure");
    });
  });

  // ── getSchedule ────────────────────────────────────────────

  describe("getSchedule", () => {
    it("returns null for non-existent schedule", () => {
      assert.equal(getSchedule("nonexistent"), null);
    });

    it("reads schedule from disk", () => {
      const config = makeConfig({ name: "readable" });
      createSchedule(config);

      const schedule = getSchedule("readable");
      assert.ok(schedule);
      assert.equal(schedule.name, "readable");
      assert.equal(schedule.prompt, config.prompt);
    });

    it("throws on corrupt JSON", () => {
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      writeFileSync(join(SCHEDULES_DIR, "corrupt.json"), "not json{{{");
      assert.throws(() => getSchedule("corrupt"), /Failed to load schedule/);
    });

    it("rejects a list-wrapped or non-object file (shape guard)", () => {
      // `[]` / `[{...}]` is valid JSON and an object, so a bare `as Schedule`
      // cast would accept it — then the scheduler acts on a nameless,
      // enabled-undefined "schedule". Reject the shape instead.
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      writeFileSync(join(SCHEDULES_DIR, "arr.json"), "[]");
      assert.throws(() => getSchedule("arr"), /found an array/);
      writeFileSync(join(SCHEDULES_DIR, "str.json"), '"hi"');
      assert.throws(() => getSchedule("str"), /found a string/);
    });

    it("rejects a schedule missing a required field", () => {
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      // valid JSON object, but no `enabled` boolean and no `target` string
      writeFileSync(
        join(SCHEDULES_DIR, "partial.json"),
        JSON.stringify({ name: "partial", schedule: "0 0 * * *" }),
      );
      assert.throws(() => getSchedule("partial"), /missing a string "target"/);
    });

    it("rejects a config-shaped file that is missing its state object", () => {
      // A file with every ScheduleConfig field but no `state` used to pass the
      // cast, then crash initScheduler (scheduler.ts derefs `s.state` OUTSIDE
      // its per-schedule try). Reject here so listSchedules skips-with-warning.
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      writeFileSync(
        join(SCHEDULES_DIR, "stateless.json"),
        JSON.stringify({
          name: "stateless",
          schedule: "0 0 * * *",
          target: "agent:worker",
          prompt: "do the thing",
          enabled: true,
        }),
      );
      assert.throws(() => getSchedule("stateless"), /missing its "state"/);
    });
  });

  // ── updateSchedule ─────────────────────────────────────────

  describe("updateSchedule", () => {
    it("merges partial config updates", () => {
      createSchedule(makeConfig({ name: "updatable", prompt: "old prompt" }));
      const updated = updateSchedule("updatable", { prompt: "new prompt" });

      assert.equal(updated.prompt, "new prompt");
      assert.equal(updated.schedule, "0 9 * * 1-5"); // unchanged
    });

    it("preserves state on update", () => {
      const schedule = createSchedule(makeConfig({ name: "state-safe" }));
      // Manually set state
      schedule.state.runCount = 42;
      schedule.state.lastRunStatus = "success";
      saveSchedule("state-safe", schedule);

      const updated = updateSchedule("state-safe", { prompt: "changed" });
      assert.equal(updated.state.runCount, 42);
      assert.equal(updated.state.lastRunStatus, "success");
    });

    it("cannot change name via update", () => {
      createSchedule(makeConfig({ name: "immutable-name" }));
      const updated = updateSchedule("immutable-name", {
        name: "new-name",
        prompt: "changed",
      } as Partial<ScheduleConfig>);

      // Name should remain unchanged
      assert.equal(updated.name, "immutable-name");
    });

    it("throws for non-existent schedule", () => {
      assert.throws(
        () => updateSchedule("ghost", { prompt: "boo" }),
        /not found/,
      );
    });
  });

  // ── deleteSchedule ─────────────────────────────────────────

  describe("deleteSchedule", () => {
    it("removes the file and returns true", () => {
      createSchedule(makeConfig({ name: "deletable" }));
      assert.ok(existsSync(join(SCHEDULES_DIR, "deletable.json")));

      const result = deleteSchedule("deletable");
      assert.equal(result, true);
      assert.ok(!existsSync(join(SCHEDULES_DIR, "deletable.json")));
    });

    it("returns false for non-existent schedule", () => {
      assert.equal(deleteSchedule("nonexistent"), false);
    });
  });

  // ── listSchedules ──────────────────────────────────────────

  describe("listSchedules", () => {
    it("returns empty object when no schedules", () => {
      const result = listSchedules();
      assert.deepEqual(result, {});
    });

    it("returns all schedules keyed by name", () => {
      createSchedule(makeConfig({ name: "alpha" }));
      createSchedule(makeConfig({ name: "beta" }));

      const result = listSchedules();
      assert.ok(result.alpha);
      assert.ok(result.beta);
      assert.equal(Object.keys(result).length, 2);
    });

    it("skips non-JSON files", () => {
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      writeFileSync(join(SCHEDULES_DIR, "readme.txt"), "not a schedule");
      createSchedule(makeConfig({ name: "real-one" }));

      const result = listSchedules();
      assert.equal(Object.keys(result).length, 1);
      assert.ok(result["real-one"]);
    });

    it("skips corrupt files without crashing", () => {
      mkdirSync(SCHEDULES_DIR, { recursive: true });
      writeFileSync(join(SCHEDULES_DIR, "broken.json"), "{{{invalid");
      createSchedule(makeConfig({ name: "good-one" }));

      const result = listSchedules();
      assert.equal(Object.keys(result).length, 1);
      assert.ok(result["good-one"]);
    });
  });

  // ── validateScheduleInput ──────────────────────────────────

  describe("validateScheduleInput", () => {
    it("accepts valid cron", () => {
      assert.equal(validateScheduleInput({ schedule: "0 9 * * 1-5" }), null);
    });

    it("accepts valid once: date", () => {
      assert.equal(
        validateScheduleInput({ schedule: "once:2026-12-31T12:00:00Z" }),
        null,
      );
    });

    it("rejects invalid cron", () => {
      const err = validateScheduleInput({ schedule: "not a cron" });
      assert.ok(err);
      assert.match(err!, /Invalid cron expression/);
    });

    it("rejects invalid once: date", () => {
      const err = validateScheduleInput({ schedule: "once:totally-bogus" });
      assert.equal(err, "Invalid one-time date format");
    });

    it("rejects empty schedule string", () => {
      const err = validateScheduleInput({ schedule: "   " });
      assert.equal(err, "schedule must be a non-empty string");
    });

    it("rejects invalid target", () => {
      const err = validateScheduleInput({ target: "local" });
      assert.ok(err);
      assert.match(err!, /must be "agent:<name>"/);
    });

    it("rejects the removed 'isolated' target, and SAYS it was removed", () => {
      // Not folded into the generic invalid-target case on purpose. An
      // operator with a pre-removal schedule needs to learn that the target
      // used to be valid and what replaces it — "Invalid target" alone reads
      // like they typo'd something that never existed.
      const err = validateScheduleInput({ target: "isolated" });
      assert.ok(err);
      assert.match(err!, /removed/);
      assert.match(err!, /agent:<name>/);
    });

    it("accepts an agent: target", () => {
      assert.equal(validateScheduleInput({ target: "agent:worker" }), null);
    });

    it("rejects invalid overlap policy", () => {
      const err = validateScheduleInput({
        overlapPolicy: "queue" as unknown as "skip",
      });
      assert.ok(err);
      assert.match(err!, /Unsupported overlap policy/);
    });

    it("accepts partial input (missing fields OK)", () => {
      assert.equal(validateScheduleInput({ prompt: "new prompt" }), null);
    });

    it("uses existing timezone on partial update when none provided", () => {
      const existing: Schedule = {
        ...makeConfig({ name: "tz-test" }),
        timezone: "America/Los_Angeles",
        state: {
          lastRunAt: null,
          lastRunStatus: null,
          nextRunAt: null,
          runCount: 0,
          consecutiveFailures: 0,
          currentRunId: null,
        },
      };
      // Updating only the schedule with a valid cron should pass,
      // validator resolves timezone from existing config.
      assert.equal(
        validateScheduleInput({ schedule: "0 5 * * *" }, { existing }),
        null,
      );
    });
  });
});

// ── Run History (JSONL) ──────────────────────────────────────

describe("run history", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("appendRun", () => {
    it("creates JSONL file and appends record", () => {
      const record = makeRunRecord();
      appendRun("my-sched", record);

      const filePath = join(RUNS_DIR, "my-sched.jsonl");
      assert.ok(existsSync(filePath));

      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.runId, record.runId);
      assert.equal(parsed.status, "success");
    });

    it("appends multiple records", () => {
      appendRun("multi", makeRunRecord({ status: "success" }));
      appendRun("multi", makeRunRecord({ status: "failure" }));
      appendRun("multi", makeRunRecord({ status: "skipped" }));

      const filePath = join(RUNS_DIR, "multi.jsonl");
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      assert.equal(lines.length, 3);
    });
  });

  describe("getRecentRuns", () => {
    it("returns empty array for non-existent file", () => {
      const runs = getRecentRuns("no-runs");
      assert.deepEqual(runs, []);
    });

    it("returns all runs when fewer than limit", () => {
      appendRun("few-runs", makeRunRecord());
      appendRun("few-runs", makeRunRecord());

      const runs = getRecentRuns("few-runs", 10);
      assert.equal(runs.length, 2);
    });

    it("returns only the last N runs", () => {
      for (let i = 0; i < 20; i++) {
        appendRun("many-runs", makeRunRecord({ runId: `run-${i}` }));
      }

      const runs = getRecentRuns("many-runs", 5);
      assert.equal(runs.length, 5);
      assert.equal(runs[0].runId, "run-15");
      assert.equal(runs[4].runId, "run-19");
    });

    it("skips corrupt JSONL lines", () => {
      mkdirSync(RUNS_DIR, { recursive: true });
      const filePath = join(RUNS_DIR, "corrupt-lines.jsonl");
      const goodRecord = makeRunRecord({ runId: "good-one" });
      writeFileSync(
        filePath,
        `${JSON.stringify(goodRecord)}\n{{{bad json\n${JSON.stringify(makeRunRecord({ runId: "good-two" }))}\n`,
      );

      const runs = getRecentRuns("corrupt-lines", 10);
      assert.equal(runs.length, 2);
      assert.equal(runs[0].runId, "good-one");
      assert.equal(runs[1].runId, "good-two");
    });
  });

  describe("pruneRuns", () => {
    it("does nothing when under the limit", () => {
      for (let i = 0; i < 5; i++) {
        appendRun("under-limit", makeRunRecord({ runId: `run-${i}` }));
      }

      pruneRuns("under-limit", 10);

      const runs = getRecentRuns("under-limit", 100);
      assert.equal(runs.length, 5);
    });

    it("trims to maxLines keeping most recent", () => {
      for (let i = 0; i < 10; i++) {
        appendRun("over-limit", makeRunRecord({ runId: `run-${i}` }));
      }

      pruneRuns("over-limit", 3);

      const runs = getRecentRuns("over-limit", 100);
      assert.equal(runs.length, 3);
      assert.equal(runs[0].runId, "run-7");
      assert.equal(runs[1].runId, "run-8");
      assert.equal(runs[2].runId, "run-9");
    });

    it("does nothing for non-existent file", () => {
      // Should not throw
      pruneRuns("nonexistent", 10);
    });
  });
});
