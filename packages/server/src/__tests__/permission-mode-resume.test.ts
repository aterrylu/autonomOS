/**
 * Cross-layer permission-mode agreement on a REAL spawn (CI-gated).
 *
 * This is the suite the reported bug needed. Everything here compares TWO
 * layers for the same agent — the argv the OS process is actually running with,
 * and the record the API serves — because each layer is self-consistent when
 * they disagree, and no single-layer assertion can tell.
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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * Full argv of `pid`, or "" if it's gone.
 *
 * Two ways argv gets silently shortened, either of which makes a matching
 * process look like no process at all:
 *   - `ps` renders to terminal width and falls back to 80 columns when stdout
 *     isn't a tty (it never is here). `-ww` removes the limit.
 *   - `--append-system-prompt` contains newlines, so line-based parsing keeps
 *     only the first line. Flatten before matching.
 *
 * /proc is preferred where it exists: the kernel's own copy, no formatting
 * layer to truncate. (Neither trap is what broke this suite on CI — see
 * `waitForProcessMode` — but both are real and cheap to close.)
 */
function argvOf(pid: string): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
  } catch {
    // Not Linux (or the process exited) — fall back to ps, unrestricted width.
  }
  try {
    return execFileSync("ps", ["-ww", "-p", pid, "-o", "command="], {
      encoding: "utf-8",
    }).replace(/\n/g, " ");
  } catch {
    return ""; // raced with exit
  }
}

/**
 * The permission flags the live PTY for `agentId` is actually running with.
 *
 * Reads the OS rather than anything the server reports — the whole class of bug
 * here is the server's own view disagreeing with the process.
 */
function processMode(agentId: string): "bypass" | "other" | "no-process" {
  let pids: string;
  try {
    pids = execFileSync("pgrep", ["-f", "claude"], { encoding: "utf-8" });
  } catch {
    return "no-process"; // pgrep exits 1 when nothing matches
  }
  for (const pid of pids.split("\n").filter(Boolean)) {
    const argv = argvOf(pid);
    if (!argv.includes(agentId)) continue;
    return argv.includes("--dangerously-skip-permissions") ? "bypass" : "other";
  }
  return "no-process";
}

/**
 * Poll until `agentId`'s PTY reports `expected`, then assert it.
 *
 * A fixed sleep is not good enough here and CI proved it: `restart-all` kills
 * every PTY and respawns them one at a time, each doing binary resolution, a
 * resumability probe and a PTY spawn. On a loaded runner two agents took longer
 * than a 10s wait, so the argv check ran against a process that had not come
 * back yet and read `no-process` — a real timing artifact, NOT a permission
 * defect (the record assertions in the same test passed).
 *
 * Polling also keeps the failure honest: on timeout it reports what was
 * actually observed, so a genuine wrong-mode failure can never be mistaken for
 * a slow respawn.
 */
async function waitForProcessMode(
  agentId: string,
  expected: "bypass" | "other",
  label: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = processMode(agentId);
  while (seen !== expected && Date.now() < deadline) {
    await sleep(1000);
    seen = processMode(agentId);
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
    await waitForProcessMode(
      agent.id,
      "bypass",
      "the process must match the record it kept",
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
    await waitForProcessMode(
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
    await waitForProcessMode(agent.id, "bypass", "fresh bypass spawn argv");
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
    await waitForProcessMode(
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
    await waitForProcessMode(
      autonomous.id,
      "bypass",
      "the respawned autonomous agent must still carry skip-permissions",
    );
    await waitForProcessMode(
      supervised.id,
      "other",
      "the respawned supervised agent must still carry no permission flag",
    );
  });
});
