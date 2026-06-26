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
  waitFor,
} from "./helpers/embedded-server.js";
import {
  type MockAnthropic,
  startMockAnthropic,
} from "./helpers/mock-anthropic.js";

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
 * actually executing — with NO manual keystrokes from anyone. The older
 * embedded-mode suite drives the terminal WebSocket by hand ("one Enter to
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

// Generous: covers trust-dialog retries AND a worst-case fallback
// re-delivery at SessionStart + 20s, plus CI scheduling noise.
const TURN_TIMEOUT_MS = 60_000;

// A marker that can only reach the mock backend inside the prompt itself.
const PROMPT_MARKER = "PROMPT_DELIVERY_RECEIPT_7f3a";

describe("starting prompt delivery — no manual keystrokes", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-prompt-cwd-"));

  before(async () => {
    mock = await startMockAnthropic({ mode: "text", text: "Done." });
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

  async function getHookStatus(id: string): Promise<HookStatus> {
    const { body } = await authedJson<HookStatus>(
      server,
      `/api/hooks/${id}/status`,
    );
    return body;
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
          // Prompt delivery is permission-mode-agnostic. Pin to "default"
          // (supervised) so the spawn never emits --dangerously-skip-permissions,
          // which Claude Code refuses when the CI runner is root. This restores
          // the pre-ADR-045 behavior of this raw POST /api/agents path, whose
          // old default resolved to supervised.
          permissionMode: "default",
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
    // regression would hide behind the 20s re-delivery crutch and CI would
    // stay green while every real spawn got slower and double-pasted.
    const { body: notif } = await authedJson<{
      notifications: Array<{ event: string; message?: string }>;
    }>(server, `/api/hooks/${agent.id}/notifications`);
    const warnings = (notif.notifications ?? []).filter(
      (n) => n.event === "SystemWarning",
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
