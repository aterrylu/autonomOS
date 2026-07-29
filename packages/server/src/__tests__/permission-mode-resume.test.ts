/**
 * Cross-layer permission-mode agreement on a REAL spawn (CI-gated).
 *
 * This is the suite the reported bug needed. Everything here compares TWO
 * layers for the same agent — the concrete argv the server handed the OS, and
 * the record the API serves — because each layer is self-consistent when they
 * disagree, and no single-layer assertion can tell.
 *
 * Two directions, and both have now been wrong at some point:
 *
 *   - a resume WITH an explicit mode must move the record to it. It didn't:
 *     `markRunning` had no `permissionMode` in its patch type, so the PTY ran
 *     the new mode while the record advertised the old one, permanently.
 *
 *   - a resume WITHOUT a mode must leave the record alone. This one broke while
 *     FIXING the first: the callers pre-collapsed `undefined` to the fail-closed
 *     fallback, so once the write-back existed, a body-less resume overwrote a
 *     deliberately `bypass` agent with `ask` — permanently, silently, and only
 *     on the path a fleet-recovery script uses most.
 *
 * The pair is the point. A test for either one alone passes on a build that has
 * the other backwards.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  authedJson,
  type BootedServer,
  bootServer,
  RUN_INTEGRATION,
  sleep,
} from "./helpers/test-server.js";

interface AgentRecord {
  id: string;
  name: string;
  permissionMode: string;
}

/**
 * The permission flags the server most recently LAUNCHED `agentId` with, read
 * from its own `[runtime] spawning:` log line.
 *
 * This — not the live process — is the reliable source in CI, and the reason is
 * specific: `--dangerously-skip-permissions` is refused by the real `claude`
 * binary under CI/root (the documented constraint behind ADR-045's default
 * flip). A `bypass` agent therefore starts, is rejected, and exits; the ADR-049
 * crash net then mints a FRESH providerSessionId and respawns, so nothing in
 * `ps` carries the original id any more and a live-process probe reads
 * "no-process" no matter how long it waits. Two CI runs proved that in turn:
 * a fixed wait failed, and so did polling to a 45s deadline.
 *
 * What this still checks is exactly the thing the bug was about — the argv the
 * server handed the OS versus the record it kept. It is strictly the concrete
 * launch arguments, not the server's opinion of a mode.
 *
 * Reads the LAST matching spawn, so a respawn supersedes the original. The
 * permission flags are pushed first in claude's argv and the session id
 * immediately after, so a short window past the marker contains both without
 * risking a match against later, unrelated log output.
 */
function launchedMode(
  server: BootedServer,
  agentId: string,
): "bypass" | "other" | "never-spawned" {
  let result: "bypass" | "other" | "never-spawned" = "never-spawned";
  for (const chunk of server.logs().split("[runtime] spawning:").slice(1)) {
    const head = chunk.slice(0, 400);
    if (!head.includes(agentId)) continue;
    result = head.includes("--dangerously-skip-permissions")
      ? "bypass"
      : "other";
  }
  return result;
}

/**
 * Assert what `agentId` was launched with, polling briefly because a respawn
 * (restart-all in particular) writes its spawn line only once it gets there.
 *
 * On failure it reports what was actually observed, so a genuine wrong-mode
 * result can never be misread as a slow respawn.
 */
async function expectLaunchedMode(
  server: BootedServer,
  agentId: string,
  expected: "bypass" | "other",
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = launchedMode(server, agentId);
  while (seen !== expected && Date.now() < deadline) {
    await sleep(500);
    seen = launchedMode(server, agentId);
  }
  assert.equal(seen, expected, `${label} (observed "${seen}")`);
}

describe("permission mode — process and record agree across a resume", {
  skip: !RUN_INTEGRATION
    ? "requires AUTONOMOS_INTEGRATION=1 and `claude` on PATH"
    : false,
  timeout: 180_000,
}, () => {
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-permmode-work-"));

  before(async () => {
    server = await bootServer();
  });

  after(async () => {
    if (server) {
      server.kill();
      rmSync(server.configDir, { recursive: true, force: true });
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  async function spawn(body: Record<string, unknown>): Promise<AgentRecord> {
    const { status, body: agent } = await authedJson<AgentRecord>(
      server,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({ workingDirectory: workdir, ...body }),
      },
    );
    assert.equal(status, 201, `spawn failed: ${JSON.stringify(agent)}`);
    return agent;
  }

  async function recordedMode(id: string): Promise<string> {
    const { body } = await authedJson<AgentRecord>(server, `/api/agents/${id}`);
    return body.permissionMode;
  }

  it("a body-less resume PRESERVES a deliberately autonomous agent", async () => {
    const agent = await spawn({
      name: "resume-preserve",
      permissionMode: "bypass",
    });
    await sleep(4000);
    assert.equal(await recordedMode(agent.id), "bypass", "spawned as bypass");

    await authedJson(server, `/api/agents/${agent.id}/kill`, {
      method: "POST",
    });
    await sleep(3000);

    // The fleet-recovery shape: resume by id, say nothing about permissions.
    await spawn({ resumeAgentId: agent.id });
    await sleep(5000);

    assert.equal(
      await recordedMode(agent.id),
      "bypass",
      "a resume that says nothing about permissions must not re-level the agent",
    );
    await expectLaunchedMode(
      server,
      agent.id,
      "bypass",
      "the relaunch must match the record it kept",
    );
  });

  it("a resume WITH an explicit mode moves the record to it", async () => {
    const agent = await spawn({ name: "resume-explicit" });
    await sleep(4000);
    assert.equal(
      await recordedMode(agent.id),
      "ask",
      "default fallback is ask",
    );

    await authedJson(server, `/api/agents/${agent.id}/kill`, {
      method: "POST",
    });
    await sleep(3000);

    await spawn({ resumeAgentId: agent.id, permissionMode: "bypass" });
    await sleep(5000);

    // Before the fix this was the divergence: process bypass, record ask.
    await expectLaunchedMode(
      server,
      agent.id,
      "bypass",
      "the explicit mode must reach the argv",
    );
    assert.equal(
      await recordedMode(agent.id),
      "bypass",
      "AND the record must follow it — this is the reported bug",
    );
  });

  it("a fresh spawn agrees across argv, record and API", async () => {
    const agent = await spawn({
      name: "fresh-agreement",
      permissionMode: "bypass",
    });
    await sleep(4000);
    await expectLaunchedMode(
      server,
      agent.id,
      "bypass",
      "fresh bypass spawn argv",
    );
    assert.equal(await recordedMode(agent.id), "bypass");

    const { body: all } = await authedJson<AgentRecord[]>(
      server,
      "/api/agents",
    );
    assert.equal(
      all.find((a) => a.id === agent.id)?.permissionMode,
      "bypass",
      "the list endpoint must report the same mode as the record and the process",
    );
  });

  it("the pre-rename spelling is accepted on the wire and normalized", async () => {
    // Agents spawned before the rename hold the OLD tool schema and keep
    // sending "default". Rejecting it would turn a rename into a hard failure
    // for the running fleet; accepting it silently as garbage would land on
    // "ask" by accident. Assert it is understood, not merely tolerated.
    const agent = await spawn({
      name: "legacy-spelling",
      permissionMode: "default",
    });
    await sleep(4000);
    assert.equal(await recordedMode(agent.id), "ask");
    await expectLaunchedMode(
      server,
      agent.id,
      "other",
      "ask must emit no skip-permissions flag",
    );
  });
});

/**
 * restart-all gets its OWN server instance.
 *
 * Not a workaround for a product bug — `POST /api/agents/restart-all` was
 * verified against a standalone isolated instance with both 1 and 5 live
 * agents: the server survives, the API stays reachable, every agent respawns,
 * and the log is clean. What it cannot safely share is a test fixture: it kills
 * and respawns EVERY PTY on the box, so running it alongside tests that assume
 * their own agents stay up makes those tests depend on the order they happen to
 * run in. A destructive fleet-wide operation gets a fleet of its own.
 */
describe("restart-all preserves per-agent permission modes", {
  skip: !RUN_INTEGRATION
    ? "requires AUTONOMOS_INTEGRATION=1 and `claude` on PATH"
    : false,
  timeout: 180_000,
}, () => {
  let server: BootedServer;
  const workdir = mkdtempSync(join(tmpdir(), "autonomos-permmode-fleet-"));

  before(async () => {
    server = await bootServer();
  });
  after(async () => {
    if (server) {
      server.kill();
      rmSync(server.configDir, { recursive: true, force: true });
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  it("does not level a mixed fleet in either direction", async () => {
    // The security question that prompted this work. It must exercise the
    // REAL endpoint: a unit test that loops markRunning with each record's
    // own mode reimplements the caller under test and stays green even if
    // respawnAgent starts consulting a global.
    const mk = async (name: string, permissionMode?: string) => {
      const { status, body } = await authedJson<AgentRecord>(
        server,
        "/api/agents",
        {
          method: "POST",
          body: JSON.stringify({
            workingDirectory: workdir,
            name,
            ...(permissionMode ? { permissionMode } : {}),
          }),
        },
      );
      assert.equal(status, 201, `spawn ${name} failed`);
      return body;
    };
    const modeOf = async (id: string) =>
      (await authedJson<AgentRecord>(server, `/api/agents/${id}`)).body
        .permissionMode;

    const supervised = await mk("fleet-ask");
    const autonomous = await mk("fleet-bypass", "bypass");
    await sleep(6000);
    assert.equal(await modeOf(supervised.id), "ask");
    assert.equal(await modeOf(autonomous.id), "bypass");

    const { status } = await authedJson(server, "/api/agents/restart-all", {
      method: "POST",
    });
    assert.equal(status, 200);
    await sleep(10_000);

    assert.equal(
      await modeOf(supervised.id),
      "ask",
      "restart-all must not ELEVATE a supervised agent",
    );
    assert.equal(
      await modeOf(autonomous.id),
      "bypass",
      "restart-all must not DEMOTE a deliberately autonomous agent",
    );
    // Records agreeing with themselves is not enough — check the argv the
    // respawned processes actually carry. Polled, because respawning a whole
    // fleet is slower than any fixed wait worth hard-coding.
    await expectLaunchedMode(
      server,
      autonomous.id,
      "bypass",
      "the respawned autonomous agent must still be launched with skip-permissions",
    );
    await expectLaunchedMode(
      server,
      supervised.id,
      "other",
      "the respawned supervised agent must still be launched with no permission flag",
    );
  });
});
