import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
    target: "isolated",
    prompt: "test prompt",
    workingDirectory: "~/workspace",
    enabled: true,
    ...overrides,
  };
}

/**
 * Creates a fake ChildProcess that emits events like a real one.
 * Tests can control when it emits close/error to simulate behavior.
 */
function createFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: (signal?: string) => boolean;
  pid: number;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: (signal?: string) => boolean;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 12345;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

// ── Isolated executor tests ────────────────────────────────────

describe("executeIsolated (real code path)", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("passes correct args to spawn with autonomous=true (default)", async () => {
    let capturedArgs: {
      cmd: string;
      args: string[];
      opts: Record<string, unknown>;
    } | null = null;
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
        capturedArgs = { cmd, args, opts };
        // Simulate successful exit
        setTimeout(() => fakeChild.emit("close", 0), 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(makeConfig({ name: "spawn-args", prompt: "Hello world" }));
    initScheduler();
    runScheduleNow("spawn-args");

    // Wait for async close
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(capturedArgs);
    const args = capturedArgs as {
      cmd: string;
      args: string[];
      opts: Record<string, unknown>;
    };
    assert.equal(args.cmd, "/usr/local/bin/claude");
    assert.deepEqual(args.args, [
      "-p",
      "Hello world",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
    ]);
  });

  it("omits --dangerously-skip-permissions when autonomous=false", async () => {
    let capturedArgs: string[] = [];
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: ((_cmd: string, args: string[]) => {
        capturedArgs = args;
        setTimeout(() => fakeChild.emit("close", 0), 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(
      makeConfig({ name: "no-perms", prompt: "test", autonomous: false }),
    );
    initScheduler();
    runScheduleNow("no-perms");

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(!capturedArgs.includes("--dangerously-skip-permissions"));
    assert.deepEqual(capturedArgs, ["-p", "test", "--output-format", "text"]);
  });

  it("expands ~ in workingDirectory to HOME", async () => {
    let capturedCwd: string | undefined;
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
        capturedCwd = opts.cwd;
        setTimeout(() => fakeChild.emit("close", 0), 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(
      makeConfig({ name: "expand-home", workingDirectory: "~/projects" }),
    );
    initScheduler();
    runScheduleNow("expand-home");

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(capturedCwd);
    assert.ok(!capturedCwd!.startsWith("~"), "~ should be expanded");
    assert.ok(capturedCwd!.endsWith("/projects"));
  });

  it("fails when resolveClaudePath throws", () => {
    _setDependencies({
      resolveClaudePath: () => {
        throw new Error("claude not found in PATH");
      },
    });

    createSchedule(makeConfig({ name: "no-binary" }));
    initScheduler();
    runScheduleNow("no-binary");

    const runs = getRecentRuns("no-binary", 10);
    const failRun = runs.find((r) => r.status === "failure");
    assert.ok(failRun);
    assert.ok(failRun!.error?.includes("claude binary not found"));
  });

  it("fails when HOME is not set and path starts with ~", () => {
    const origHome = process.env.HOME;
    delete process.env.HOME;

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
    });

    createSchedule(
      makeConfig({ name: "no-home", workingDirectory: "~/workspace" }),
    );
    initScheduler();
    runScheduleNow("no-home");

    // Restore HOME
    process.env.HOME = origHome;

    const runs = getRecentRuns("no-home", 10);
    const failRun = runs.find((r) => r.status === "failure");
    assert.ok(failRun);
    assert.ok(failRun!.error?.includes("Cannot resolve working directory"));
  });

  it("captures stdout on success (exit code 0)", async () => {
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: (() => {
        setTimeout(() => {
          fakeChild.stdout.emit(
            "data",
            Buffer.from("Task completed successfully"),
          );
          fakeChild.emit("close", 0);
        }, 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(makeConfig({ name: "stdout-ok" }));
    initScheduler();
    runScheduleNow("stdout-ok");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("stdout-ok", 10);
    const successRun = runs.find((r) => r.status === "success");
    assert.ok(successRun);
    assert.equal(successRun!.output, "Task completed successfully");
  });

  it("records failure with exit code on non-zero exit", async () => {
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: (() => {
        setTimeout(() => {
          fakeChild.stderr.emit("data", Buffer.from("Error: something broke"));
          fakeChild.emit("close", 1);
        }, 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(makeConfig({ name: "exit-fail" }));
    initScheduler();
    runScheduleNow("exit-fail");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("exit-fail", 10);
    const failRun = runs.find((r) => r.status === "failure");
    assert.ok(failRun);
    assert.equal(failRun!.error, "Exit code 1");
    assert.equal(failRun!.output, "Error: something broke");
  });

  it("records failure on spawn error", async () => {
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: (() => {
        setTimeout(() => fakeChild.emit("error", new Error("ENOENT")), 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(makeConfig({ name: "spawn-err" }));
    initScheduler();
    runScheduleNow("spawn-err");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("spawn-err", 10);
    const failRun = runs.find((r) => r.status === "failure");
    assert.ok(failRun);
    assert.equal(failRun!.error, "ENOENT");
  });

  it("truncates output over 10KB in run record", async () => {
    const fakeChild = createFakeChild();
    const bigOutput = "x".repeat(15_000);

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: (() => {
        setTimeout(() => {
          fakeChild.stdout.emit("data", Buffer.from(bigOutput));
          fakeChild.emit("close", 0);
        }, 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(makeConfig({ name: "truncate-output" }));
    initScheduler();
    runScheduleNow("truncate-output");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("truncate-output", 10);
    const successRun = runs.find((r) => r.status === "success");
    assert.ok(successRun);
    assert.ok(successRun!.output!.length < bigOutput.length);
    assert.ok(successRun!.output!.endsWith("... (truncated)"));

    // Full output should be saved to .out file
    const outDir = join(TEST_DIR, "schedule-runs", "truncate-output");
    assert.ok(existsSync(outDir));
    const outFiles = readFileSync(
      join(outDir, `${successRun!.runId}.out`),
      "utf-8",
    );
    assert.equal(outFiles.length, bigOutput.length);
  });

  it("ignores duplicate close events (double-completion guard)", async () => {
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: (() => {
        setTimeout(() => {
          fakeChild.emit("close", 0);
          fakeChild.emit("close", 0); // duplicate
        }, 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    createSchedule(makeConfig({ name: "double-close" }));
    initScheduler();
    runScheduleNow("double-close");

    await new Promise((r) => setTimeout(r, 50));

    const runs = getRecentRuns("double-close", 10);
    const successRuns = runs.filter((r) => r.status === "success");
    assert.equal(successRuns.length, 1, "should only record one success");
  });
});

// ── Agent executor tests ───────────────────────────────────────

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

describe("onComplete callback", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("delivers result to onComplete URI after isolated run", async () => {
    const deliveries: { to: string; message: string }[] = [];
    const fakeChild = createFakeChild();

    _setDependencies({
      resolveClaudePath: () => "/usr/local/bin/claude",
      spawn: (() => {
        setTimeout(() => fakeChild.emit("close", 0), 5);
        return fakeChild;
      }) as unknown as typeof import("node:child_process").spawn,
      routeMessage: async (to, message) => {
        deliveries.push({ to, message });
        return null;
      },
    });

    createSchedule(
      makeConfig({
        name: "on-complete",
        target: "isolated",
        onComplete: "agent://reporter",
      }),
    );
    initScheduler();
    runScheduleNow("on-complete");

    await new Promise((r) => setTimeout(r, 100));

    assert.ok(deliveries.length >= 1, "should deliver onComplete callback");
    const delivery = deliveries.find((d) => d.to === "agent://reporter");
    assert.ok(delivery);
    assert.ok(delivery!.message.includes("on-complete"));
    assert.ok(delivery!.message.includes("success"));
  });

  it("does NOT deliver onComplete for agent mode", async () => {
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

    await new Promise((r) => setTimeout(r, 50));

    // The only routeMessage call should be the agent delivery itself
    const reporterCalls = deliveries.filter((d) => d.to === "agent://reporter");
    assert.equal(
      reporterCalls.length,
      0,
      "onComplete should not fire for agent mode",
    );
  });
});
