import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ScheduleConfig } from "@autonomos/core";

// ── Test isolation ─────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `autonomos-exec-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { createSchedule, getRecentRuns } = await import("../schedules.js");

const {
  initScheduler,
  runScheduleNow,
  getActiveRunCount,
  _resetForTesting,
  _setDependencies,
} = await import("../scheduler.js");

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(
    join(TEST_DIR, "settings.json"),
    JSON.stringify({ scheduler: { maxConcurrentRuns: 3 } }),
  );
}

function makeConfig(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    name: `exec-${randomUUID().slice(0, 8)}`,
    schedule: "0 9 * * 1-5",
    target: "agent:worker",
    prompt: "test prompt",
    workingDirectory: "~/workspace",
    enabled: true,
    ...overrides,
  };
}

describe("executeAgentSend (real code path)", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("calls routeMessage with correct URI and prompt", async () => {
    let capturedCall: { to: string; message: string; from: string } | null =
      null;

    _setDependencies({
      routeMessage: async (to, message, from) => {
        capturedCall = { to, message, from };
        return null; // success
      },
    });

    createSchedule(
      makeConfig({
        name: "agent-route",
        target: "agent:my-worker",
        prompt: "Run the deployment",
      }),
    );
    initScheduler();
    runScheduleNow("agent-route");

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(capturedCall);
    const call = capturedCall as { to: string; message: string; from: string };
    assert.equal(call.to, "agent://my-worker");
    assert.equal(call.message, "Run the deployment");
    assert.equal(call.from, "scheduler");
  });

  it("records success when routeMessage returns null", async () => {
    _setDependencies({
      routeMessage: async () => null,
    });

    createSchedule(makeConfig({ name: "agent-ok", target: "agent:worker" }));
    initScheduler();
    runScheduleNow("agent-ok");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("agent-ok", 10);
    const successRun = runs.find((r) => r.status === "success");
    assert.ok(successRun);
  });

  it("records failure when routeMessage returns error string", async () => {
    _setDependencies({
      routeMessage: async () => "Agent not found",
    });

    createSchedule(makeConfig({ name: "agent-fail", target: "agent:ghost" }));
    initScheduler();
    runScheduleNow("agent-fail");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("agent-fail", 10);
    const failRun = runs.find((r) => r.status === "failure");
    assert.ok(failRun);
    assert.equal(failRun!.error, "Agent not found");
  });

  it("records failure when routeMessage throws", async () => {
    _setDependencies({
      routeMessage: async () => {
        throw new Error("Gateway connection lost");
      },
    });

    createSchedule(makeConfig({ name: "agent-throw", target: "agent:dead" }));
    initScheduler();
    runScheduleNow("agent-throw");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("agent-throw", 10);
    const failRun = runs.find((r) => r.status === "failure");
    assert.ok(failRun);
    assert.ok(failRun!.error?.includes("Gateway connection lost"));
  });
});

// ── onComplete callback tests ──────────────────────────────────

describe("onComplete (deprecated with the isolated target)", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("does NOT fire for an agent: run — 'completed' there only means delivered", () => {
    // This is the reason onComplete was deprecated rather than rehomed onto
    // the surviving target. For the removed `isolated` executor a run
    // completed when the child exited, so "completed: success" meant the task
    // had RUN. executeAgentSend reports success as soon as routeMessage
    // returns no error — the agent has not started. Firing here would
    // announce a completion that has not happened.
    const deliveries: { to: string }[] = [];
    _setDependencies({
      routeMessage: async (to) => {
        deliveries.push({ to });
        return null;
      },
    });

    createSchedule(
      makeConfig({
        name: "no-oncomplete",
        target: "agent:worker",
        onComplete: "agent://reporter",
      }),
    );
    initScheduler();
    runScheduleNow("no-oncomplete");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // The only routeMessage call is the agent delivery itself.
        assert.equal(
          deliveries.filter((d) => d.to === "agent://reporter").length,
          0,
          "onComplete must not report a completion the agent has not reached",
        );
        assert.equal(
          deliveries.filter((d) => d.to === "agent://worker").length,
          1,
          "the prompt itself must still be delivered",
        );
        resolve();
      }, 50);
    });
  });
});
