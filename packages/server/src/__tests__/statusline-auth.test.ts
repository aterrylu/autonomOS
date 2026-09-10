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
    fix(A, { managerId: mgr.id });
    const res = await agentsRouter.request(`/${A}/self`, {
      headers: { "X-Agent-Token": mintAgentToken(A) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, `sl-01`);
    assert.equal(body.managerName, `sl-02`);
    assert.equal(body.directReports, 0);
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
