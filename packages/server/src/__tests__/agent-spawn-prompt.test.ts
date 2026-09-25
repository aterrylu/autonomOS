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
  boundedTeardown,
  HOOK_TIMEOUT,
  RUN_INTEGRATION,
  waitFor,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — prompt delivery.
 *
 * Regression suite for the silently-dropped starting prompt: an agent spawned
 * via create_agent/POST /api/agents with a prompt would sometimes sit at an
 * empty input box forever because the auto-trust Enter raced CC's stdin
 * attach, the trust dialog never dismissed, and the argv-queued prompt never
 * submitted. The creating agent then waited forever.
 *
 * The guarantee under test: a spawn WITH a prompt leads to that prompt
 * actually executing — with NO manual keystrokes from anyone. An earlier
 * hands-on approach drove the terminal WebSocket by hand ("one Enter to
 * submit the queued prompt"), which works around this exact bug instead of
 * catching it. This suite deliberately never touches the terminal: delivery
 * must succeed through the argv path, the hardened needle-driven auto-trust
 * watcher, or the receipt-tracked PTY re-delivery fallback.
 */

interface AgentRecord {
  id: string;
  name: string;
  status: "running" | "exited";
}
interface HookStatus {
  status: string;
  lastEvent: string;
}

// Generous: covers trust-dialog retries AND the worst-case settle-gated
// fallback re-delivery (settle + 90s submit window per ADR-074), plus CI
// scheduling noise. A waitFor cap, not a sleep — costs nothing when green.
const TURN_TIMEOUT_MS = 180_000;

// A marker that can only reach the mock backend inside the prompt itself.
const PROMPT_MARKER = "PROMPT_DELIVERY_RECEIPT_7f3a";

describe("starting prompt delivery — no manual keystrokes", {
  skip: !RUN_INTEGRATION,
  // Must stay ABOVE TURN_TIMEOUT_MS: node:test propagates this to subtests,
  // so a lower value would kill the it() before waitFor's own cap and CI
  // would report a bare suite timeout instead of this file's diagnostics
  // (last hook event / status + server logs).
  timeout: 200_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-prompt-cwd-"));

  before(async () => {
    // Held: the test inspects the agent mid-turn, then releases the reply.
    mock = await startMockAnthropic({
      mode: "text",
      text: "Done.",
      holdResponses: true,
    });
    server = await bootServer({
      anthropicBaseUrl: mock.url,
      anthropicAuthToken: "sk-mock",
    });
  }, HOOK_TIMEOUT);

  after(() =>
    boundedTeardown("agent-spawn-prompt", async () => {
      if (server) {
        await server.kill();
        rmSync(server.configDir, { recursive: true, force: true });
      }
      if (mock) await mock.close();
      rmSync(workdir, { recursive: true, force: true });
    }),
  );

  async function getHookStatus(id: string): Promise<HookStatus> {
    // Reads the BULK endpoint — the per-session single was removed in the
    // dead-surface pass (this harness was its last caller). An id with no
    // entry yet maps to the old endpoint's "unknown" sentinel so polls that
    // start before the first hook keep their semantics.
    const { body } = await authedJson<Record<string, { status: HookStatus }>>(
      server,
      "/api/agent-status",
    );
    return (
      body[id]?.status ?? ({ status: "unknown", lastEvent: "" } as HookStatus)
    );
  }

  it("a fresh spawn with a prompt executes it end-to-end without any terminal input", async () => {
    const { status, body: agent } = await authedJson<AgentRecord>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          workingDirectory: workdir,
          name: "integ-prompt-delivery",
          prompt: `Reply with exactly: ${PROMPT_MARKER}`,
        }),
      },
    );
    assert.equal(status, 201, "POST /api/agents must create the agent");

    // Ground truth first: the prompt TEXT reached the model backend. That
    // can only happen if the prompt was actually submitted into the session,
    // with no keystroke. Waiting on this, not on the final hook status, keeps
    // the test independent of hook arrival order (the old wait on Stop|idle
    // failed under concurrent boots when async hooks landed out of order).
    const promptReachedModel = () =>
      mock.requests.some(
        (r) =>
          r.method === "POST" &&
          r.url.includes("/v1/messages") &&
          !r.url.includes("count_tokens") &&
          JSON.stringify(r.body ?? {}).includes(PROMPT_MARKER),
      );
    const submitted = await waitFor(async () => promptReachedModel(), {
      timeoutMs: TURN_TIMEOUT_MS,
    });
    const atSubmit = await getHookStatus(agent.id);
    assert.ok(
      submitted,
      `the starting prompt must reach the model WITHOUT any manual keystroke ` +
        `(last hook event: "${atSubmit.lastEvent}", status: "${atSubmit.status}"). ` +
        `If this fails, prompt delivery regressed — the agent is sitting at an ` +
        `empty input box again.\nServer logs:\n${server.logs()}`,
    );

    // The mock is holding its reply, so the turn is frozen mid-flight: Stop
    // cannot have fired. UserPromptSubmit is a SYNCHRONOUS hook (claude-code
    // ORDERED_HOOK_EVENTS), so Claude Code waited for it to land before making
    // this model call. The server has therefore already recorded it, and it is
    // the latest event. With async turn hooks this could read SessionStart.
    // Read once, no grace window: a synchronous hook's curl has returned, so
    // the server finished ingesting it, before Claude Code made this call.
    const midTurn = await getHookStatus(agent.id);
    assert.equal(
      midTurn.lastEvent,
      "UserPromptSubmit",
      `UserPromptSubmit must already be recorded when the model call is made ` +
        `(status: "${midTurn.status}") — the turn hooks must be synchronous ` +
        `so they arrive in order.`,
    );
    assert.equal(midTurn.status, "working");

    // Release the reply; the turn completes and Stop lands after UPS.
    mock.release();
    const turnCompleted = await waitFor(
      async () => {
        const st = await getHookStatus(agent.id);
        return st.lastEvent === "Stop" && st.status === "idle";
      },
      { timeoutMs: 60_000 },
    );
    const finalState = await getHookStatus(agent.id);
    assert.ok(
      turnCompleted,
      `after the reply, the agent must end idle on Stop ` +
        `(last hook event: "${finalState.lastEvent}", status: "${finalState.status}").\n` +
        `Server logs:\n${server.logs()}`,
    );

    // The fallback must NOT have been needed: re-delivery pushes a
    // SystemWarning notification, so its absence proves the PRIMARY path
    // (argv + auto-trust watcher) delivered. Without this, a watcher
    // regression would hide behind the (settle + 90s) re-delivery crutch and
    // CI would stay green while every real spawn got slower and double-pasted.
    // Bulk feed (the per-session single was deleted in this PR — and its 404
    // body made this assertion pass VACUOUSLY, which for a fallback-must-not-
    // fire guard is the worst failure mode). The bulk feed carries
    // SystemWarning events, so filtering by sessionId preserves the check —
    // and the presence-probe below proves the read itself works.
    const { body: notif } = await authedJson<{
      notifications: Array<{
        event: string;
        sessionId: string;
        message?: string;
      }>;
    }>(server, "/api/notifications");
    assert.ok(
      Array.isArray(notif.notifications),
      "bulk notifications feed must answer — a missing/renamed endpoint would make the no-warning assertion vacuous",
    );
    const warnings = notif.notifications.filter(
      (n) => n.sessionId === agent.id && n.event === "SystemWarning",
    );
    assert.deepEqual(
      warnings,
      [],
      `the argv prompt path must deliver WITHOUT the re-delivery fallback ` +
        `firing — the fallback is a safety net, not the delivery mechanism.\n` +
        `Server logs:\n${server.logs()}`,
    );

    // Cleanup: kill the agent (scoped to the id we own).
    await authedJson(server, `/api/agents/${agent.id}/kill`, {
      method: "POST",
    });
  });

  // Runs LAST in this describe (tests run in order), after every spawn above.
  // A real test, not an after() hook: node's runner reports a failing after()
  // as "not ok" but does NOT count it or fail the exit code, so a leak there
  // would pass CI silently (verified by mutation).
  it("leaves nothing in the operator's real ~/.claude (fake-HOME harness)", () => {
    server.assertNoRealHomeLeak();
  });
});
