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
 * The permission flags the server LAUNCHED `agentId` with, from its own
 * `[runtime] spawning:` lines, plus how many times it has spawned that agent.
 *
 * Reads the log rather than a live process, and the reason is specific:
 * `--dangerously-skip-permissions` is refused by the real `claude` binary under
 * CI/root (the constraint behind ADR-045's default flip), so a `bypass` agent
 * starts, is rejected and exits. Nothing in `ps` survives to be inspected. The
 * log line is the concrete argv handed to the OS, which is exactly the side of
 * the comparison this suite needs, and it is stable either way.
 *
 * Returns the FLAG STRING, not a bypass/other verdict: a two-value answer would
 * report `ask` and `auto` identically, so an ask→auto re-levelling — a real
 * autonomy change — would pass every argv assertion in this file.
 *
 * `spawns` exists so a caller can prove a respawn actually happened. Without it
 * a "mode unchanged" assertion is satisfied by the PREVIOUS spawn's line, which
 * is how the restart-all check came to pass while testing nothing (an agent
 * that had already exited was never in `live`, so restart-all skipped it).
 */
function launchedPermission(
  server: BootedServer,
  agentId: string,
): { flags: string; spawns: number } {
  let flags = "never-spawned";
  let spawns = 0;
  for (const chunk of server.logs().split("[runtime] spawning:").slice(1)) {
    // Permission flags are pushed first in claude's argv and the session id
    // immediately after, so a short window holds both without risking a match
    // against later, unrelated log output.
    const head = chunk.slice(0, 400);
    if (!head.includes(agentId)) continue;
    spawns++;
    if (head.includes("--dangerously-skip-permissions")) flags = "bypass";
    else {
      const m = head.match(/--permission-mode\s+(\S+)/);
      flags = m ? `permission-mode:${m[1]}` : "none";
    }
  }
  return { flags, spawns };
}

/** Flags claude is launched with for each of our modes. `ask` emits none. */
const EXPECTED_FLAGS: Record<string, string> = {
  ask: "none",
  auto: "permission-mode:acceptEdits",
  plan: "permission-mode:plan",
  bypass: "bypass",
};

/**
 * Assert the flags `agentId` was launched with, polling to a deadline because
 * a spawn line is written asynchronously.
 *
 * `minSpawns` guards against the vacuous pass described on `launchedPermission`:
 * pass 2 after a restart to require that a NEW spawn line exists, so the
 * assertion cannot be satisfied by the pre-restart one.
 */
async function expectLaunchedWith(
  server: BootedServer,
  agentId: string,
  mode: keyof typeof EXPECTED_FLAGS,
  label: string,
  {
    minSpawns = 1,
    timeoutMs = 45_000,
  }: { minSpawns?: number; timeoutMs?: number } = {},
): Promise<void> {
  const want = EXPECTED_FLAGS[mode];
  const deadline = Date.now() + timeoutMs;
  let seen = launchedPermission(server, agentId);
  while (
    (seen.flags !== want || seen.spawns < minSpawns) &&
    Date.now() < deadline
  ) {
    await sleep(500);
    seen = launchedPermission(server, agentId);
  }
  assert.equal(
    seen.flags,
    want,
    `${label} — expected the flags for "${mode}" (observed "${seen.flags}"). ` +
      `Server log tail:\n${logTail(server)}`,
  );
  assert.ok(
    seen.spawns >= minSpawns,
    `${label} — expected at least ${minSpawns} spawn(s) of this agent, saw ${seen.spawns}. ` +
      `Fewer means the operation under test never relaunched it, so this assertion proved nothing. ` +
      `Server log tail:\n${logTail(server)}`,
  );
}

/**
 * Last chunk of the booted server's stdout+stderr, for assertion messages.
 * The three CI flakes of the restart-all suite were undiagnosable from the
 * failure alone — the TAP output carried only "saw 1 spawn" while the story
 * (which agent exited, when, and why restart-all skipped it) lived in the
 * server child's log that nothing surfaced. Every timing-sensitive assertion
 * in this file appends this so the NEXT flake ships its own forensics.
 */
function logTail(server: BootedServer, chars = 2000): string {
  const logs = server.logs();
  return logs.length > chars ? `…${logs.slice(-chars)}` : logs;
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
    await expectLaunchedWith(
      server,
      agent.id,
      "bypass",
      "the relaunch must match the record it kept",
      { minSpawns: 2 }, // the resume must have actually relaunched it
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
    await expectLaunchedWith(
      server,
      agent.id,
      "bypass",
      "the explicit mode must reach the argv",
      { minSpawns: 2 },
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
    await expectLaunchedWith(
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
    await expectLaunchedWith(
      server,
      agent.id,
      "ask",
      "the normalized legacy spelling must launch as ask (no permission flag)",
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
    // The security question that prompted this work. It must exercise the REAL
    // endpoint: a unit test that loops markRunning with each record's own mode
    // reimplements the caller under test and stays green even if respawnAgent
    // starts consulting a global.
    //
    // The permissive member is `auto`, NOT `bypass`, and that matters. In CI the
    // real claude refuses --dangerously-skip-permissions, so a bypass agent
    // exits immediately; restart-all snapshots `Array.from(live.keys())` and an
    // exited agent has already been live.delete()d, so it is never restarted at
    // all. Both of this test's assertions then passed while touching nothing —
    // the record nobody wrote to, and a spawn line from before the restart.
    // `auto` emits --permission-mode acceptEdits, which claude accepts, so the
    // agent survives to actually be restarted. `minSpawns: 2` below makes the
    // vacuous version impossible to write again.
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
    const statusOf = async (id: string) =>
      (
        await authedJson<AgentRecord & { status: string }>(
          server,
          `/api/agents/${id}`,
        )
      ).body.status;

    // ENVIRONMENT-RETRY WRAPPER (the fix for a 3×-in-one-day CI flake).
    //
    // The scenario needs both REAL claude processes to survive from spawn to
    // restart-all's live-map snapshot. When one dies at boot first (confirmed
    // mechanism at the time of writing: CC ≥2.1.26x flipped the trust dialog
    // default to "No, exit", so auto-trust's Enter exits the session when it
    // lands — timing-dependent, hence flaky; any future boot-death has the
    // same shape), restart-all CORRECTLY skips it (it restarts live agents,
    // and an exited agent has left `live`), and the old fixed-sleep version
    // burned a 45s poll to fail with "saw 1 spawn" — measuring the runner
    // environment, not the product. Reproduced deterministically with a fake
    // `claude` killed pre-restart: record flips to "exited", restart-all
    // returns failures: [] with the dead id absent from idMap, spawn count
    // stays 1.
    //
    // `idMap` is the race-free classifier the old version never read: it is
    // the snapshot's own output, so an id missing from it while the record
    // still says "running" means restart-all DROPPED a live agent — the real
    // bug this test exists to catch, and it still fails hard. Missing while
    // the record says exited/crashed means the runner killed the agent before
    // the snapshot — environment, never a restart-all verdict — so the
    // attempt is discarded and a FRESH pair is spawned (bounded; agents are
    // per-attempt so a dead attempt's records can't satisfy anything).
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      const supervised = await mk(`fleet-ask-${attempt}`);
      const permissive = await mk(`fleet-auto-${attempt}`, "auto");

      // Settle-gate, not a timer: wait for both spawn argv lines (the
      // pre-restart baseline the minSpawns: 2 below builds on).
      await expectLaunchedWith(
        server,
        supervised.id,
        "ask",
        `attempt ${attempt}: pre-restart supervised argv`,
      );
      await expectLaunchedWith(
        server,
        permissive.id,
        "auto",
        `attempt ${attempt}: pre-restart permissive argv`,
      );
      assert.equal(await modeOf(supervised.id), "ask");
      assert.equal(await modeOf(permissive.id), "auto");

      const { status, body: restart } = await authedJson<{
        idMap: Record<string, string>;
        failures: Array<{ id: string; name: string; error: string }>;
      }>(server, "/api/agents/restart-all", { method: "POST" });
      assert.equal(status, 200);

      const missing = [supervised, permissive].filter(
        (a) => !(a.id in restart.idMap),
      );
      if (missing.length > 0) {
        for (const a of missing) {
          // A respawn that was TRIED and failed is a product outcome, never
          // environment noise — and the sets are disjoint by construction:
          // an agent the environment killed at boot left `live` before the
          // snapshot, so it is never in `toRestart` and can never appear in
          // `failures`. Check it first so a real respawn failure fails HERE
          // with its error, instead of burning retries and blaming the
          // runner.
          const failed = restart.failures.find((f) => f.id === a.id);
          assert.equal(
            failed,
            undefined,
            `restart-all TRIED and failed to respawn ${a.name}: ` +
              `${failed?.error} — a product bug, not runner noise. ` +
              `Server log tail:\n${logTail(server)}`,
          );
          // A live agent absent from the snapshot's output = dropped by the
          // product. Only an agent the environment already killed may be
          // missing without failing the test.
          assert.notEqual(
            await statusOf(a.id),
            "running",
            `restart-all returned without restarting ${a.name}, whose record ` +
              `still says "running" — a LIVE agent was dropped (product bug, ` +
              `not runner noise). failures=${JSON.stringify(restart.failures)} ` +
              `Server log tail:\n${logTail(server)}`,
          );
        }
        assert.ok(
          attempt < MAX_ATTEMPTS,
          `the claude process of ${missing.map((a) => a.name).join(", ")} died ` +
            `before restart-all's snapshot on ${attempt} consecutive attempts — ` +
            `the runner is killing agents at boot, so the restart-all contract ` +
            `was never exercised. Not a restart-all verdict. ` +
            `Server log tail:\n${logTail(server)}`,
        );
        // Surfaced in the TAP stream so a CI run that needed retries says so
        // even when it ultimately passes — a rising retry rate is the early
        // warning that the runner environment is degrading again.
        console.warn(
          `[mixed-fleet] attempt ${attempt} discarded (environment): ` +
            `${missing.map((a) => a.name).join(", ")} exited before the ` +
            `restart-all snapshot; retrying with a fresh pair`,
        );
        continue;
      }
      assert.deepEqual(
        restart.failures,
        [],
        `restart-all reported respawn failures. Server log tail:\n${logTail(server)}`,
      );

      // Records first — the guarantee itself.
      assert.equal(
        await modeOf(supervised.id),
        "ask",
        "restart-all must not ELEVATE a supervised agent",
      );
      assert.equal(
        await modeOf(permissive.id),
        "auto",
        "restart-all must not DEMOTE a more permissive agent",
      );

      // Then the argv of the RESPAWNED processes. minSpawns: 2 is what makes
      // this real: it fails if restart-all skipped the agent, rather than
      // quietly re-reading the original spawn line.
      await expectLaunchedWith(
        server,
        permissive.id,
        "auto",
        "the respawned permissive agent must still be launched with acceptEdits",
        { minSpawns: 2 },
      );
      await expectLaunchedWith(
        server,
        supervised.id,
        "ask",
        "the respawned supervised agent must still be launched with no permission flag",
        { minSpawns: 2 },
      );
      return;
    }
  });
});
