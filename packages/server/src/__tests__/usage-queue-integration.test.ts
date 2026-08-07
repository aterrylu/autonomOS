import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { RateLimitData } from "../plugins/claude-usage/scanner.js";
import { createUsageQueue, normalizeClaudeUsage } from "../usageQueue.js";
import {
  type MockAnthropic,
  startMockAnthropic,
} from "./helpers/mock-anthropic.js";
import {
  authedJson,
  type BootedServer,
  bootServer,
  RUN_INTEGRATION,
  sleep,
  waitFor,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — usage-queue auto-fire.
 *
 * The 12 unit tests in `usage-queue.test.ts` pin the edge detector with mocked
 * usage + a fake `sendSubmit`. What they cannot prove is the load-bearing
 * real-world assumption the whole feature rests on: that the queue's fire — a
 * lone carriage return written to the PTY — actually submits a prompt that's
 * been typed-but-not-sent into a REAL Claude Code TUI input box.
 *
 * This test spawns a real `claude`, types a marker prompt WITHOUT pressing
 * Enter (the user's exact situation: capped, prompt buffered, unsent), then
 * arms a REAL `createUsageQueue` whose usage mock transitions capped→cleared
 * and whose `sendSubmit` writes `\r` over the terminal WebSocket — the same
 * server-side `pty.write("\r")` the production `sendSubmit` performs via
 * `getAttachment`. The assertion is the strongest possible receipt: the marker
 * reaches the mock model backend, which can only happen if the buffered prompt
 * was actually submitted.
 */

const MARKER = "USAGE_QUEUE_AUTOFIRE_2c9e";

/** A usage snapshot at the given 5-hour utilization% (0–100 scale). */
function usageAt(utilization: number): RateLimitData {
  return {
    fiveHour: { utilization, resetsAt: "" },
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    account: {},
    fetchedAt: new Date().toISOString(),
  };
}

interface AgentRecord {
  id: string;
  name: string;
  status: "running" | "exited";
}
interface HookStatus {
  status: string;
  lastEvent: string;
}

describe("usage-queue auto-fire — real spawn", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-usageq-cwd-"));

  before(async () => {
    mock = await startMockAnthropic({ mode: "text", text: "Done." });
    server = await bootServer({
      anthropicBaseUrl: mock.url,
      anthropicAuthToken: "sk-mock",
    });
  });

  after(async () => {
    if (server) {
      server.kill();
      rmSync(server.configDir, { recursive: true, force: true });
    }
    if (mock) await mock.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  async function hookStatus(id: string): Promise<HookStatus> {
    const { body } = await authedJson<HookStatus>(
      server,
      `/api/hooks/${id}/status`,
    );
    return body;
  }

  function sawMarker(): boolean {
    return mock.requests.some(
      (r) =>
        r.method === "POST" &&
        r.url.includes("/v1/messages") &&
        !r.url.includes("count_tokens") &&
        JSON.stringify(r.body ?? {}).includes(MARKER),
    );
  }

  it("fires Enter on an observed limit-clear, submitting the buffered prompt", async () => {
    // Spawn WITHOUT a prompt — the agent sits at an empty input box, exactly
    // like a user who just hit the limit and hasn't sent their next prompt.
    const { status, body: agent } = await authedJson<AgentRecord>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          workingDirectory: workdir,
          name: "integ-usage-queue",
        }),
      },
    );
    assert.equal(status, 201, "POST /api/agents must create the agent");

    // Wait for the session to come up (hook relay alive, TUI booted +
    // auto-trusted), then let CC's stdin handler attach + input box settle.
    await waitFor(
      async () => {
        const s = await hookStatus(agent.id);
        return s.lastEvent === "SessionStart" || s.status === "idle";
      },
      { timeoutMs: 60_000 },
    );
    await sleep(2500);

    // Type the prompt into CC's input box over the real terminal WebSocket,
    // but DO NOT submit it — the queue's auto-Enter will.
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws/terminal/${agent.id}?token=${server.token}`,
    );
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("terminal WS failed")), {
        once: true,
      });
    });
    ws.send(`Reply with exactly: ${MARKER}`);
    await sleep(1500); // text is now buffered in the input box, unsent

    assert.ok(!sawMarker(), "nothing should be submitted before the fire");

    // The REAL queue: usage mock transitions capped→cleared; sendSubmit writes
    // the carriage return over the same PTY path the server uses.
    let cleared = false;
    const queue = createUsageQueue({
      probes: {
        "claude-code": async () =>
          normalizeClaudeUsage(usageAt(cleared ? 0 : 100)),
      },
      sendSubmit: () => {
        ws.send("\r");
        return true;
      },
      evaluateOnArm: false,
      intervalMs: 1_000_000_000,
    });
    queue.arm(agent.id, "claude-code");

    await queue.tick(); // still capped → must NOT fire
    assert.ok(!sawMarker(), "must not submit while the limit is still capped");

    cleared = true;
    await queue.tick(); // observed clear → fires \r → CC submits

    const submitted = await waitFor(async () => sawMarker(), {
      timeoutMs: 30_000,
    });
    assert.ok(
      submitted,
      "the queue's auto-Enter must submit the buffered prompt in real CC — " +
        `the marker never reached the model.\nServer logs:\n${server.logs()}`,
    );

    queue.stop();
    ws.close();
    await authedJson(server, `/api/agents/${agent.id}/kill`, {
      method: "POST",
    });
  });
});
