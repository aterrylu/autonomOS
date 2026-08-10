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

    // The full receipt chain, hands-off: SessionStart proves the hook relay,
    // UserPromptSubmit proves the prompt was SUBMITTED (the bug was exactly
    // this event never firing), Stop proves the turn ran to completion
    // against the mock. lastEvent is a moving cursor, so wait for the
    // terminal state of the turn rather than each intermediate event.
    const turnCompleted = await waitFor(
      async () => {
        const s = await getHookStatus(agent.id);
        return s.lastEvent === "Stop" || s.status === "idle";
      },
      { timeoutMs: TURN_TIMEOUT_MS },
    );
    const finalState = await getHookStatus(agent.id);
    assert.ok(
      turnCompleted,
      `the starting prompt must execute WITHOUT any manual keystroke ` +
        `(last hook event: "${finalState.lastEvent}", status: "${finalState.status}"). ` +
        `If this fails, prompt delivery regressed — the agent is sitting at an ` +
        `empty input box again.\nServer logs:\n${server.logs()}`,
    );

    // The strongest receipt: the prompt TEXT reached the model backend. This
    // can only happen if the prompt was actually submitted into the session.
    const sawMarker = mock.requests.some(
      (r) =>
        r.method === "POST" &&
        r.url.includes("/v1/messages") &&
        !r.url.includes("count_tokens") &&
        JSON.stringify(r.body ?? {}).includes(PROMPT_MARKER),
    );
    assert.ok(
      sawMarker,
      "the starting prompt text must appear in a /v1/messages request body — " +
        "proves the exact prompt (argv or re-delivered) reached the model",
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
});
