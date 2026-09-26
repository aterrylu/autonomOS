/**
 * A SERVER RESTART must not leave an unread badge on an agent that never had
 * a turn (ReleaseRollout's forge repro, 2026-09-26). A prompt-less claude-code
 * agent has no saved session, so the reattach starts fresh (ADR-111) — that
 * fresh start used to push "had no saved … session to resume" as an unread
 * SystemWarning on every restart, although nothing was lost. Real claude,
 * real restart on the SAME config dir (so the agent is resumed, not new).
 */

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
  sleep,
  waitFor,
} from "./helpers/test-server.js";

type Status = Record<string, { status: { status: string }; unread: number }>;
type Note = { event: string; sessionId: string; message?: string };

describe("server restart adds no unread to a never-used agent — real spawn", {
  skip: !RUN_INTEGRATION,
  timeout: 180_000,
}, () => {
  let mock: MockAnthropic;
  let server: BootedServer;
  const cwd = mkdtempSync(join(tmpdir(), "autonomos-restart-unread-"));

  before(async () => {
    mock = await startMockAnthropic({ mode: "text", text: "ok" });
    server = await bootServer({
      anthropicBaseUrl: mock.url,
      anthropicAuthToken: "sk-mock",
    });
  }, HOOK_TIMEOUT);

  const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
  after(() =>
    boundedTeardown("restart-unread", async () => {
      await server?.kill();
      if (server) rmSync(server.configDir, RM);
      await mock?.close();
      rmSync(cwd, RM);
    }),
  );

  it("prompt-less agent: fresh start on restart, but unread stays 0 and no SystemWarning", async () => {
    const { status, body: agent } = await authedJson<{ id: string }>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({ workingDirectory: cwd, name: "never-used" }),
      },
    );
    assert.equal(status, 201);
    const statusOf = async () =>
      (await authedJson<Status>(server, "/api/agent-status")).body[agent.id];
    assert.ok(
      await waitFor(async () => (await statusOf())?.status.status === "ready", {
        timeoutMs: 60_000,
      }),
      `agent booted (SessionStart)\n${server.logs()}`,
    );

    // Restart the SERVER on the same config dir: the agent is RESUMED.
    await server.kill();
    server = await bootServer({
      anthropicBaseUrl: mock.url,
      anthropicAuthToken: "sk-mock",
      reuseConfigDir: server.configDir,
    });
    assert.ok(
      await waitFor(async () => (await statusOf())?.status.status === "ready", {
        timeoutMs: 60_000,
      }),
      `agent resumed after restart\n${server.logs()}`,
    );
    // Precondition: the no-saved-session fresh start actually happened (else a
    // clean badge proves nothing).
    assert.match(
      server.logs(),
      /no saved .* session for .*; starting fresh/,
      `expected the reattach to start fresh\n${server.logs()}`,
    );
    await sleep(3000); // any post-resume notice lands within ~1s (forge repro)

    const s = await statusOf();
    assert.equal(s?.unread, 0, `unread after restart: ${JSON.stringify(s)}`);
    const { body } = await authedJson<{ notifications: Note[] }>(
      server,
      "/api/notifications",
    );
    assert.ok(Array.isArray(body.notifications), "notifications feed answers");
    const mine = body.notifications.filter((n) => n.sessionId === agent.id);
    assert.deepEqual(mine, [], `no notification: ${JSON.stringify(mine)}`);
  });

  // A real test, not an after() hook: a failing after() doesn't fail the run.
  it("leaves nothing in the operator's real ~/.claude (fake-HOME harness)", () => {
    server.assertNoRealHomeLeak();
  });
});
