import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  authedJson,
  type BootedServer,
  bootEmbedded,
  RUN_INTEGRATION,
  sleep,
  waitFor,
} from "./helpers/embedded-server.js";
import {
  type MockAnthropic,
  startMockAnthropic,
} from "./helpers/mock-anthropic.js";

/**
 * L3 integration — boots the REAL server as a child process exactly the way
 * the Desktop's `acquireOrConnect()` / `acquireEphemeral()` do, then exercises
 * the HTTP surface that spawned Claude Code sessions hit (hooks, /api/agents).
 *
 * CI-only (AUTONOMOS_INTEGRATION=1) — see helpers/embedded-server.ts for the
 * gate rationale and the harness itself.
 *
 * The headline test spawns the REAL `claude` binary through autonomOS's real
 * provider → node-pty → hook-relay path, pointed at a MOCK Anthropic backend
 * (helpers/mock-anthropic.ts) via ANTHROPIC_BASE_URL — so the full lifecycle
 * runs at ZERO API cost. We assert on BEHAVIOR (the agent reaches running, the
 * server receives the real SessionStart/UserPromptSubmit/Stop hook telemetry,
 * the agent exits cleanly), never on the model's text.
 *
 * Catches the class of bugs pure unit tests miss:
 *   - Module-init crashes (e.g. node-pty ABI mismatch)
 *   - Server doesn't actually bind / never emits AUTONOMOS_READY
 *   - serverState.ts wiring breaks the spawn URL path (#178)
 *   - Auth token resolution wiring breaks the spawn token path (#178)
 *   - HTTP routes panic on auth headers
 *   - pid file claim path doesn't survive a real spawn
 *   - provider `buildEnv()`/`buildArgs()` regressions that break a real spawn
 *   - hook-relay `--settings` JSON that a real `claude` rejects
 */

interface AgentRecord {
  id: string;
  name: string;
  status: "running" | "exited";
  exitReason?: string;
}
interface HookStatus {
  status: string;
  lastEvent: string;
  updatedAt: number;
}

// ── Suite 1: server boot + auth + #178 wiring (no agent spawn) ────────
describe("embedded mode end-to-end", { skip: !RUN_INTEGRATION }, () => {
  let server: BootedServer;

  before(async () => {
    server = await bootEmbedded();
  });

  after(() => {
    if (server) {
      server.kill();
      rmSync(server.configDir, { recursive: true, force: true });
    }
  });

  it("server binds to an ephemeral port (not the default 3000)", () => {
    assert.ok(server.port > 0, "port should be assigned");
    assert.notEqual(
      server.port,
      3000,
      "embedded mode with --port=0 must NOT fall back to the default 3000",
    );
    assert.ok(server.port < 65536, "port must be in valid range");
  });

  it("GET /api/system/version returns 200 with the configured token", async () => {
    const { status, body } = await authedJson<{ version: string }>(
      server,
      "/api/system/version",
    );
    assert.equal(status, 200, "auth-protected endpoint must succeed");
    assert.ok(
      typeof body.version === "string" && body.version.length > 0,
      "version field must be present",
    );
  });

  it("GET /api/system/version rejects requests without the token", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/system/version`,
    );
    assert.equal(
      res.status,
      401,
      "missing token must be rejected (regression guard against auth bypass)",
    );
  });

  it("token isolation — writes to CONFIG_DIR, not ~/.autonomos", async () => {
    // The server got AUTONOMOS_TOKEN via env, so it shouldn't have written
    // any token to disk. But if it had, it'd be in CONFIG_DIR, not the
    // user's prod ~/.autonomos. We verify the CONFIG_DIR is isolated by
    // checking the pid file lands there (proves CONFIG_DIR is honored
    // for non-auth state too).
    const pidFile = join(server.configDir, "autonomos.pid");
    const { existsSync, readFileSync } = await import("node:fs");
    assert.ok(existsSync(pidFile), "pid file must be in CONFIG_DIR");
    const pid = JSON.parse(readFileSync(pidFile, "utf-8")) as {
      port: number;
    };
    assert.equal(
      pid.port,
      server.port,
      "pid file port must match the actual bound port (regression guard for #178 — serverState wiring)",
    );
  });
});

// ── Suite 2: REAL claude spawn against the MOCK Anthropic backend ─────
//
// This is the headline L3 test. It drives a real `claude` PTY through the
// real provider/hook-relay path and asserts the lifecycle + telemetry.
describe("real-agent spawn against mock Anthropic backend", {
  skip: !RUN_INTEGRATION,
  timeout: 90_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-agent-cwd-"));

  before(async () => {
    mock = await startMockAnthropic({ mode: "text", text: "Done." });
    // Wire the spawned agent at the mock via the real settings path.
    server = await bootEmbedded({
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

  /** Fetch the agent record from the store-backed collection. */
  async function getAgent(id: string): Promise<AgentRecord | undefined> {
    const { status, body } = await authedJson<AgentRecord>(
      server,
      `/api/agents/${id}`,
    );
    return status === 200 ? body : undefined;
  }

  /** Fetch the hook-derived agent state (proves hooks reached the server). */
  async function getHookStatus(id: string): Promise<HookStatus> {
    const { body } = await authedJson<HookStatus>(
      server,
      `/api/hooks/${id}/status`,
    );
    return body;
  }

  it("spawns a real claude agent, captures its hook lifecycle, and exits cleanly", async () => {
    // (a) Spawn via the real REST path the dashboard uses.
    const { status, body: agent } = await authedJson<AgentRecord>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          workingDirectory: workdir,
          name: "integ-mock-agent",
          prompt: "say done",
        }),
      },
    );
    assert.equal(status, 201, "POST /api/agents must create the agent");
    assert.ok(agent.id, "created agent must have an id");

    // (a) The agent record reaches `running` (PTY is live).
    assert.equal(
      agent.status,
      "running",
      "a freshly-spawned agent's record must be status:running",
    );

    // (b) The server RECEIVES real hook events. SessionStart fires on the
    // real claude PTY boot, posting to /api/hooks/:id — observable via the
    // hook-derived agent state. autoTrust dismisses the trust prompt.
    const sawSessionStart = await waitFor(
      async () => {
        const s = await getHookStatus(agent.id);
        // SessionStart → derived status "ready"; lastEvent is the proof.
        return s.lastEvent === "SessionStart" || s.lastEvent.length > 0;
      },
      { timeoutMs: 30_000 },
    );
    assert.ok(
      sawSessionStart,
      "server must receive at least the SessionStart hook from the real claude PTY " +
        "(proves --settings hook relay + AUTONOMOS_SERVER/SESSION_ID wiring works end-to-end)",
    );

    // Interactive claude under PTY queues the `--` prompt but waits for a
    // submit keystroke. Drive it through the REAL terminal WebSocket — the
    // exact path the dashboard uses for keystrokes — to submit the prompt
    // and complete a turn against the mock (UserPromptSubmit → Stop).
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws/terminal/${agent.id}?token=${server.token}`,
    );
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("terminal WS failed")), {
        once: true,
      });
    });
    // A couple of Enters: one belt-and-suspenders for the trust prompt (in
    // case auto-trust hasn't landed yet), one to submit the queued prompt.
    ws.send("\r");
    await sleep(1500);
    ws.send("\r");

    // (b cont.) The turn completes — server sees UserPromptSubmit then Stop.
    const sawStop = await waitFor(
      async () => (await getHookStatus(agent.id)).lastEvent === "Stop",
      { timeoutMs: 40_000 },
    );
    const afterTurn = await getHookStatus(agent.id);
    assert.ok(
      sawStop,
      `server must receive the Stop hook after the turn completes ` +
        `(last seen: "${afterTurn.lastEvent}", status: "${afterTurn.status}"). ` +
        `Proves the real provider→PTY→mock→hook-relay round trip.`,
    );
    // Stop derives to the "idle" hook-status — assert the state machine ran.
    assert.equal(
      afterTurn.status,
      "idle",
      "deriveStatus must map the Stop hook to idle",
    );

    ws.close();

    // (c) The agent terminates cleanly — kill the live PTY and assert the
    // record transitions OFF running (liveness/lifecycle). SessionEnd fires
    // on teardown, moving the hook status to stopped.
    const killRes = await authedJson(server, `/api/agents/${agent.id}/kill`, {
      method: "POST",
    });
    assert.equal(killRes.status, 200, "kill must succeed on a live agent");

    const exited = await waitFor(
      async () => (await getAgent(agent.id))?.status === "exited",
      { timeoutMs: 15_000 },
    );
    const finalRecord = await getAgent(agent.id);
    assert.ok(
      exited,
      `agent record must leave "running" after kill ` +
        `(final status: "${finalRecord?.status}"). Guards against the ` +
        `class-6 false-pass: a zombie PTY that reports running forever.`,
    );
    assert.equal(finalRecord?.status, "exited");

    // SessionEnd should have reached the server too (best-effort — the
    // hook is async and may race the kill; the lifecycle assertion above
    // is the hard gate).
    const sawSessionEnd = await waitFor(
      async () => (await getHookStatus(agent.id)).lastEvent === "SessionEnd",
      { timeoutMs: 8_000 },
    );
    if (sawSessionEnd) {
      assert.equal(
        (await getHookStatus(agent.id)).status,
        "stopped",
        "SessionEnd must derive to stopped",
      );
    }

    // The mock actually served the agent's turn — at least one
    // /v1/messages request must have hit it (proves the agent really
    // talked to OUR backend, not the real Anthropic API).
    const messagesHits = mock.requests.filter(
      (r) =>
        r.method === "POST" &&
        r.url.includes("/v1/messages") &&
        !r.url.includes("count_tokens"),
    );
    assert.ok(
      messagesHits.length >= 1,
      "the real claude agent must have streamed a turn from the mock backend",
    );
  });

  // (d) NEGATIVE CONTROL — proves this gate can FAIL. A spawn into a
  // bogus working directory must NOT produce a running agent. If the
  // server ever started returning a phantom running agent for an invalid
  // spawn (the class-6 false-pass), this assertion catches it.
  it("negative control — an invalid spawn never reaches running", async () => {
    const { status, body } = await authedJson<{ error?: string }>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          workingDirectory: "/nonexistent/autonomos/integ/path",
          name: "integ-should-fail",
          prompt: "say done",
        }),
      },
    );
    assert.notEqual(
      status,
      201,
      "spawning into a nonexistent cwd must NOT succeed — " +
        "this is the negative control proving the running-agent assertions " +
        "above are real (the test CAN fail)",
    );
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      "a failed spawn must carry an error message",
    );
    // And no phantom agent named integ-should-fail leaked into the store.
    const { body: list } = await authedJson<AgentRecord[]>(
      server,
      "/api/agents",
    );
    assert.ok(
      !list.some((a) => a.name === "integ-should-fail"),
      "a failed spawn must not leave a phantom agent record",
    );
  });
});
