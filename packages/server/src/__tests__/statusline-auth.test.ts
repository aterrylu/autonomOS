import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Config-dir isolation (test-escape guard).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-slauth-"));

const { agentsRouter } = await import("../routes/agents.js");
const { mintAgentToken } = await import("../agentCredentials.js");
const { _resetCacheForTesting, buildAgent, insertAgent } = await import(
  "../agents/store.js"
);
const fix = (id: string, extra: Record<string, unknown> = {}) =>
  insertAgent({
    ...buildAgent({
      id: id as never,
      name: `sl-${id.slice(-2)}`,
      workingDirectory: "/tmp",
      provider: "claude-code",
      providerSessionId: id,
      permissionMode: "ask",
    }),
    ...extra,
  } as never);

describe("GET /api/agents/:id/self — per-agent-token statusline metadata (#297 fix)", () => {
  beforeEach(() => _resetCacheForTesting());

  const A = "0000b111-0000-4000-8000-000000000001";
  const B = "0000b111-0000-4000-8000-000000000002";

  it("returns own hierarchy view with a valid per-agent token", async () => {
    const mgr = fix(B);
    fix(A, { managerId: mgr.id, project: "autonomOS" });
    const res = await agentsRouter.request(`/${A}/self`, {
      headers: { "X-Agent-Token": mintAgentToken(A) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, `sl-01`);
    assert.equal(body.manager, `sl-02`);
    assert.equal(body.project, "autonomOS");
    assert.equal(body.directReports, 0);
  });

  it("directReports excludes exited agents (records persist until deleted)", async () => {
    const mgr = fix(A);
    fix(B, { managerId: mgr.id });
    fix("0000b111-0000-4000-8000-0000000000ee", {
      managerId: mgr.id,
      status: "exited",
    });
    const res = await agentsRouter.request(`/${A}/self`, {
      headers: { "X-Agent-Token": mintAgentToken(A) },
    });
    assert.equal((await res.json()).directReports, 1);
  });

  it("/self and the org tree agree — ONE definition of manager + live reports", async () => {
    const { buildAgentTreeNodes } = await import("@autonomos/core");
    const { listAgents } = await import("../agents/store.js");
    const id = (n: number) =>
      `0000c222-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const lead = fix(id(1), { name: "Lead" });
    const dead = fix(id(2), { name: "Dead", status: "exited" });
    // Lead's reports: live, killed, and a FUTURE status (unknown ⇒ exited).
    fix(id(3), { name: "Twin", managerId: lead.id });
    fix(id(4), { name: "Killed", managerId: lead.id, status: "exited" });
    fix(id(5), { name: "Future", managerId: lead.id, status: "archived" });
    // Same name as a Lead report, under a DIFFERENT (dead) manager.
    fix(id(6), { name: "Twin", managerId: dead.id });
    const self = async (who: string) =>
      (
        await agentsRouter.request(`/${who}/self`, {
          headers: { "X-Agent-Token": mintAgentToken(who) },
        })
      ).json();

    // Live reports: /self count === the running-only tree's children.
    const liveTree = buildAgentTreeNodes(listAgents());
    const leadNode = liveTree.find((n) => n.id === lead.id);
    assert.equal((await self(lead.id)).directReports, 1);
    assert.equal(leadNode?.children.length, 1);

    // A dead manager: /self names it AND says it's exited; the exited-inclusive
    // tree (what the chart draws) keeps the report under that ghost.
    const orphan = await self(id(6));
    assert.equal(orphan.manager, "Dead");
    assert.equal(orphan.managerStatus, "exited");
    const fullTree = buildAgentTreeNodes(listAgents(), { includeExited: true });
    const deadNode = fullTree.find((n) => n.id === dead.id);
    assert.deepEqual(
      deadNode?.children.map((c) => c.id),
      [id(6)],
    );
    // Same-named agents stay two distinct nodes (keyed by id, never name).
    const twins = [
      ...(leadNode?.children ?? []),
      ...(deadNode?.children ?? []),
    ].filter((n) => n.name === "Twin");
    assert.equal(new Set(twins.map((t) => t.id)).size, 2);
    // A live manager reads as running.
    assert.equal((await self(id(3))).managerStatus, "running");
  });

  it("route payload → getSelfMeta → formatHierarchy renders ↑manager (SHAPE contract)", async () => {
    // The shape drift class: getSelfMeta once returned `managerName` while
    // formatHierarchy reads `ctx.manager`, so a managed worker rendered a
    // wrong-but-plausible "standalone". This feeds the REAL route payload
    // through the REAL script path so neither side can drift alone.
    const mgr = fix(B);
    fix(A, { managerId: mgr.id });
    const routeRes = await agentsRouter.request(`/${A}/self`, {
      headers: { "X-Agent-Token": mintAgentToken(A) },
    });
    const payload = await routeRes.json();

    const sl = await import("../providers/statusline.mjs");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload))) as typeof fetch;
    try {
      const meta = await sl.getSelfMeta(A, "http://stub", "tok");
      assert.ok(meta, "getSelfMeta must parse the route payload");
      const line: string = sl.formatHierarchy(meta);
      assert.match(line, /↑sl-02/, "manager arrow must render");
      assert.ok(
        !line.includes("standalone"),
        "managed agent is not standalone",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("401s without a token, and with ANOTHER agent's token (no cross-agent reads)", async () => {
    fix(A);
    fix(B);
    assert.equal((await agentsRouter.request(`/${A}/self`)).status, 401);
    const cross = await agentsRouter.request(`/${A}/self`, {
      headers: { "X-Agent-Token": mintAgentToken(B) },
    });
    assert.equal(cross.status, 401);
  });

  it("404s for a valid token whose record vanished", async () => {
    // Never-inserted id — reset clears the cache, but records persist on
    // disk in the shared isolated dir, so reuse of A would find test 1's.
    const GONE = "0000b111-0000-4000-8000-00000000dead";
    const res = await agentsRouter.request(`/${GONE}/self`, {
      headers: { "X-Agent-Token": mintAgentToken(GONE) },
    });
    assert.equal(res.status, 404);
  });
});

describe("statusline env/credential CONTRACT — script reads what spawn provides (the drift class)", () => {
  // The six-week outage happened because the script read a var spawn had
  // stopped providing, and nothing pinned the contract. These assertions
  // fail if EITHER side drifts again.
  const script = readFileSync(
    join(import.meta.dirname, "../providers/statusline.mjs"),
    "utf8",
  );

  it("script derives the token file from the vars spawn actually injects", () => {
    for (const key of [
      "AUTONOMOS_CONFIG_DIR",
      "AUTONOMOS_SESSION_ID",
      "AUTONOMOS_AGENT_TOKEN",
      '"agent-tokens"',
    ]) {
      assert.ok(script.includes(key), `statusline.mjs must reference ${key}`);
    }
    // The removed server-token var must not be the ONLY auth path: the
    // legacy read may remain for standalone setups, but the agent-token
    // path must exist.
    assert.ok(script.includes("/self"), "script must use the self endpoint");
  });

  it("spawned CC env actually provides the derivation vars (provider side of the contract)", async () => {
    const shared = await import("../providers/shared.js");
    // buildBaseEnv asserts spawn preconditions; satisfy them the way the
    // provider tests do, or fall back to a static source check if the
    // helper surface differs.
    const { setServerPort, setInternalSocketPath } = await import(
      "../serverState.js"
    );
    setServerPort(53919);
    setInternalSocketPath("/tmp/aos-sl/control.sock");
    const env = shared.buildBaseEnv(A_ID, "sl-contract");
    assert.ok(env.AUTONOMOS_CONFIG_DIR, "CONFIG_DIR in spawned env");
    assert.equal(env.AUTONOMOS_SESSION_ID, A_ID);
  });
});
const A_ID = "0000b111-0000-4000-8000-000000000009";
