import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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
 * L3 integration (CI-only) — the dev simulation control driving a real fire.
 *
 * Where `usage-queue-integration.test.ts` drives a hand-built queue, this drives
 * the ACTUAL demo path a developer uses: arm a pane over the REST API, then
 * `POST /api/usage-queue/_simulate?state=capped&resetInSec=N`, and let the
 * server's own countdown flip to cleared and fire the auto-Enter — no second
 * call. Proves the timed-reset control end-to-end against a real `claude`.
 */

const MARKER = "USAGE_QUEUE_SIM_FIRE_5b1d";

interface AgentRecord {
  id: string;
  name: string;
  status: "running" | "exited";
}
interface HookStatus {
  status: string;
  lastEvent: string;
}

// QUARANTINED — auto-trust ↔ TUI-stdin-attachment race causes consistent flake
// in CI. The test types the prompt over the terminal WS and relies on
// usage-queue's auto-Enter; it does NOT route through the production
// prompt-delivery receipt path (ADR-036 / PR #209), so it's exposed to the race
// that the receipt mechanism is designed to absorb. Reproduces locally with
// real `claude 2.1.193` + mock backend; signature is "[auto-trust] dismissed
// after N attempts" → marker never reaches the model.
// Tracked: fix the auto-trust race upstream OR route this test's prompt
// submission through the prompt-delivery receipt path, then unquarantine.
describe("usage-queue timed simulation — real spawn auto-fire", {
  skip: true,
  timeout: 120_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-usageq-sim-"));

  before(async () => {
    // The simulate endpoint is gated; the subprocess inherits this env.
    process.env.AUTONOMOS_ENABLE_USAGE_SIMULATION = "1";
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
    delete process.env.AUTONOMOS_ENABLE_USAGE_SIMULATION;
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

  it("a timed capped→clear auto-submits the buffered prompt", async () => {
    const { status, body: agent } = await authedJson<AgentRecord>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          workingDirectory: workdir,
          name: "integ-usage-sim",
        }),
      },
    );
    assert.equal(status, 201, "POST /api/agents must create the agent");

    await waitFor(
      async () => {
        const s = await hookStatus(agent.id);
        return s.lastEvent === "SessionStart" || s.status === "idle";
      },
      { timeoutMs: 60_000 },
    );
    await sleep(2500);

    // Type the prompt into CC's input box WITHOUT submitting.
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
    await sleep(1500);

    // Arm the pane over the REST API (what the button's toggle does).
    await authedJson(server, `/api/usage-queue/${agent.id}`, {
      method: "POST",
    });

    // Cap now, auto-clear in 2s — no second call. The server's countdown
    // flips to cleared and fires the armed pane.
    await authedJson(
      server,
      "/api/usage-queue/_simulate?state=capped&resetInSec=2",
      { method: "POST" },
    );
    assert.ok(!sawMarker(), "must not submit while still capped");

    const submitted = await waitFor(async () => sawMarker(), {
      timeoutMs: 30_000,
    });
    assert.ok(
      submitted,
      "the timed reset must auto-submit the buffered prompt in real CC — " +
        `the marker never reached the model.\nServer logs:\n${server.logs()}`,
    );

    ws.close();
    await authedJson(server, `/api/agents/${agent.id}/kill`, {
      method: "POST",
    });
  });
});
