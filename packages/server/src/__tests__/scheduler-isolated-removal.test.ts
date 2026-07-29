/**
 * The `isolated` target is gone, and its configuration fields are inert.
 *
 * Why this needs its own suite: the removal has to be BOTH a hard stop and a
 * soft landing, and those pull in opposite directions.
 *
 * Hard stop — `isolated` spawned a headless `claude -p` and pushed
 * `--dangerously-skip-permissions` whenever `autonomous !== false`. It was the
 * only execution path in the product outside PermissionMode, and it was
 * fail-open: omit the field, get full autonomy. Nothing may resurrect it.
 *
 * Soft landing — schedules live in files on disk and MCP clients hold their
 * tool schema in context. A schedule written before the removal must still
 * LOAD, be visible, and be editable; an agent still sending `autonomous` must
 * not get a hard tool failure. So the fields are accepted and ignored rather
 * than rejected, and the operator is told once, loudly, which schedules can
 * no longer run.
 *
 * A test that only checked "isolated is rejected" would miss the half that
 * actually risks data loss.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Schedule, ScheduleConfig } from "@autonomos/core";

const TEST_DIR = join(tmpdir(), `autonomos-isoremoval-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const {
  createSchedule,
  getRecentRuns,
  getSchedule,
  updateSchedule,
  validateScheduleInput,
} = await import("../schedules.js");
const {
  initScheduler,
  runScheduleNow,
  _resetForTesting,
  _setExecutors,
  _onRunCompleted,
} = await import("../scheduler.js");
const { TOOL_CREATE_SCHEDULE } = await import("../mcp/tools.js");

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "schedules"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, "settings.json"),
    JSON.stringify({ scheduler: { maxConcurrentRuns: 3 } }),
  );
}

function makeConfig(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    name: "sched",
    schedule: "0 9 * * *",
    target: "agent:worker",
    prompt: "do the thing",
    enabled: true,
    ...overrides,
  };
}

/** Write a schedule file exactly as the PRE-removal server wrote it. */
function writeLegacyScheduleFile(name: string, extra: Record<string, unknown>) {
  writeFileSync(
    join(TEST_DIR, "schedules", `${name}.json`),
    JSON.stringify({
      name,
      schedule: "0 9 * * *",
      prompt: "do the thing",
      workingDirectory: "~/workspace",
      enabled: false,
      state: {
        lastRunAt: null,
        lastRunStatus: null,
        nextRunAt: null,
        runCount: 0,
        consecutiveFailures: 0,
        currentRunId: null,
      },
      ...extra,
    }),
  );
}

/** Capture console.warn for the duration of `fn`. */
function captureWarnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

describe("the isolated target is removed", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("is rejected at validation, naming the replacement", () => {
    const err = validateScheduleInput({ target: "isolated" });
    assert.ok(err, "isolated must not validate");
    assert.match(err, /removed/);
    assert.match(err, /agent:<name>/);
  });

  it("fails a run with an actionable error, not a bare 'unknown target'", () => {
    // Reachable for a schedule that was already on disk and then enabled.
    writeLegacyScheduleFile("legacy-iso", {
      target: "isolated",
      enabled: true,
      autonomous: true,
    });
    _setExecutors(null);
    initScheduler();
    runScheduleNow("legacy-iso");

    const after = getSchedule("legacy-iso");
    assert.equal(after?.state.lastRunStatus, "failure");

    // The status alone proved nothing about the MESSAGE, which is the whole
    // point of this test's name — the operator-facing payload is the only
    // thing that tells them what to change. Asserted here so degrading it back
    // to a bare "Unknown target" fails.
    const [run] = getRecentRuns("legacy-iso", 1);
    assert.ok(run, "a run record must exist");
    assert.match(run.error ?? "", /removed/);
    assert.match(run.error ?? "", /agent:<name>/);
  });

  it("warns ONCE at startup about schedules that can no longer run", () => {
    // A disabled one is the case that needs this most: it has no next fire, so
    // without a startup warning it sits in the panel looking dormant rather
    // than broken, with nothing to distinguish the two.
    writeLegacyScheduleFile("legacy-disabled", {
      target: "isolated",
      enabled: false,
    });
    const warnings = captureWarnings(() => {
      initScheduler();
    });
    const named = warnings.filter((w) => w.includes("legacy-disabled"));
    assert.equal(named.length, 1, "exactly one warning naming the schedule");
    assert.match(named[0], /isolated/);
    assert.match(named[0], /agent:<name>/);
  });
});

describe("deprecated schedule fields are accepted and ignored", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("a schedule carrying all of them still validates and round-trips", () => {
    // The soft-landing half. An MCP client holding the pre-removal tool schema
    // keeps sending these; rejecting them would turn a removal into a hard
    // tool failure for every already-running agent.
    const config = makeConfig({
      name: "legacy-fields",
      autonomous: true,
      workingDirectory: "~/workspace",
      template: "some-template",
      onComplete: "agent://reporter",
    });
    assert.equal(validateScheduleInput(config), null);

    createSchedule(config);
    const stored = getSchedule("legacy-fields");
    assert.ok(stored);
    // Stored verbatim rather than stripped — a round-trip must not silently
    // mutate an operator's file. All four, not a sample: dropping any one of
    // them is a distinct way to lose their data.
    assert.equal(stored.autonomous, true);
    assert.equal(stored.workingDirectory, "~/workspace");
    assert.equal(stored.template, "some-template");
    assert.equal(stored.onComplete, "agent://reporter");
    assert.equal(stored.target, "agent:worker");
  });

  it("a PARTIAL update preserves every deprecated field", () => {
    // The data-loss scenario this whole deprecation exists to prevent, and the
    // one the create-path test above does NOT cover: editing an unrelated
    // field must not drop the ignored ones. `updateSchedule` merges onto the
    // existing record, so wiping them here would be silent — the operator sees
    // a successful edit.
    createSchedule(
      makeConfig({
        name: "partial-update",
        autonomous: true,
        workingDirectory: "~/workspace",
        template: "some-template",
        onComplete: "agent://reporter",
      }),
    );

    updateSchedule("partial-update", { description: "edited" });

    const after = getSchedule("partial-update");
    assert.ok(after);
    assert.equal(after.description, "edited");
    assert.equal(after.autonomous, true, "autonomous must survive the edit");
    assert.equal(after.workingDirectory, "~/workspace");
    assert.equal(after.template, "some-template");
    assert.equal(after.onComplete, "agent://reporter");
    assert.equal(after.target, "agent:worker");
  });

  it("`autonomous: true` grants nothing — the run is still a gateway message", () => {
    // The security point of the whole change. There is no longer a spawn for
    // this flag to reach: the executor's ONLY action is routeMessage, and the
    // autonomy of the resulting work is the receiving agent's permissionMode.
    createSchedule(makeConfig({ name: "autonomous-noop", autonomous: true }));

    const dispatched: Array<{ name: string; schedule: Schedule }> = [];
    _setExecutors((name, schedule) => {
      dispatched.push({ name, schedule });
      _onRunCompleted(name, { status: "success" });
    });
    initScheduler();
    runScheduleNow("autonomous-noop");

    assert.equal(dispatched.length, 1);
    assert.equal(
      dispatched[0].schedule.target,
      "agent:worker",
      "the only executor is the agent one; no child process is spawned",
    );
  });

  it("workingDirectory is optional now — a schedule without one validates", () => {
    // It used to be REQUIRED, and only the headless child ever read it.
    const config = makeConfig({ name: "no-cwd" });
    assert.equal(config.workingDirectory, undefined);
    assert.equal(validateScheduleInput(config), null);
    createSchedule(config);
    assert.ok(getSchedule("no-cwd"));
  });
});

describe("the schedule tool schema does not contradict itself", () => {
  // A property described as DEPRECATED while still listed in `required` tells
  // a caller two opposite things, and forces an agent to invent a value for a
  // dead field — which the POST route then persists verbatim. That is the
  // "advertised field that does nothing" shape this removal exists to end, so
  // it must not creep back in via the required array.
  //
  // This schema is what autonomOS-spawned agents see: the channel server
  // bundles it, and both MCP transports share it.
  const DEPRECATED_FIELDS = [
    "autonomous",
    "workingDirectory",
    "template",
    "onComplete",
  ];

  it("marks no deprecated field as required", () => {
    const required = TOOL_CREATE_SCHEDULE.inputSchema.required ?? [];
    for (const field of DEPRECATED_FIELDS) {
      assert.ok(
        !required.includes(field),
        `"${field}" is deprecated-and-ignored but listed in create_schedule's required array`,
      );
    }
  });

  it("says DEPRECATED in the description of every field it ignores", () => {
    // The description is the only thing telling a caller the field is inert.
    // Silence there reads as "this works".
    const props = TOOL_CREATE_SCHEDULE.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    for (const field of DEPRECATED_FIELDS) {
      assert.match(
        props[field]?.description ?? "",
        /DEPRECATED/,
        `create_schedule's "${field}" must announce that it is ignored`,
      );
    }
  });

  it("still requires the fields a schedule genuinely needs", () => {
    // Guards the opposite failure: over-trimming the required array so a
    // schedule can be created with no target or prompt.
    const required = TOOL_CREATE_SCHEDULE.inputSchema.required ?? [];
    for (const field of ["name", "schedule", "target", "prompt"]) {
      assert.ok(required.includes(field), `"${field}" must stay required`);
    }
  });
});
