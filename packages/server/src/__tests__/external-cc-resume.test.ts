import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assertAdoptable } from "../agents/runtime.js";
import {
  _resetCacheForTesting,
  buildAgent,
  getAgent,
  getAgentByProviderSessionId,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

/**
 * External Claude Code session resume — store-level resolution invariants.
 *
 * Bug (regressed in #165, "unify Agent + Session"): resuming an external CC
 * session — one started via terminal `claude`, discovered in the Projects
 * panel — 404'd. Every resume path funneled through `resumeAgentId`, which
 * `getAgent()` resolves ONLY by internal agent id. A raw CC session id has no
 * such record, so the lookup missed and the spawn threw `not found`.
 *
 * The fix adds a `resumeSessionId` (raw CC id) path in spawnAgent that resolves
 * the id against BOTH the agent store (by providerSessionId, for reattach) and
 * disk (adopt). It also unifies `id == providerSessionId` for freshly-spawned
 * agents so callers never have to guess which id to pass.
 *
 * These tests pin the store-level building blocks that resolution depends on —
 * the full adopt→spawn→--resume path is a PTY spawn and is covered by the
 * real-terminal QA. (Mirrors resume-after-self-exit.test.ts, which tests the
 * store invariant rather than the PTY.)
 */

let isolatedDir: string;

/** A managed agent whose id and providerSessionId DIFFER — the "split-id"
 *  shape produced by spawns between #165 and the id-unification fix. */
function seedSplitIdAgent(id: string, providerSessionId: string) {
  return insertAgent(
    buildAgent({
      id: id as never,
      name: "Worker",
      workingDirectory: "/tmp/proj",
      provider: "claude-code",
      providerSessionId,
      permissionMode: "default",
    }),
  );
}

/** A unified-id agent (fresh-spawn / adopted shape): id == providerSessionId. */
function seedUnifiedAgent(id: string) {
  return insertAgent(
    buildAgent({
      id: id as never,
      name: "Unified",
      workingDirectory: "/tmp/proj",
      provider: "claude-code",
      providerSessionId: id,
      permissionMode: "default",
    }),
  );
}

describe("external-cc-resume — getAgentByProviderSessionId resolver", () => {
  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-extresume-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("resolves a split-id managed agent by its CC providerSessionId", () => {
    // This is exactly the input the Projects panel sends on resume: the CC
    // session id, NOT the agent id. Pre-fix this missed → 404.
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ccId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    seedSplitIdAgent(agentId, ccId);

    const found = getAgentByProviderSessionId(ccId);
    assert.ok(found, "found by CC session id");
    assert.equal(found?.id, agentId, "resolves back to the internal agent id");
  });

  it("returns undefined for a CC id with no record → triggers the adopt path", () => {
    // An external terminal session has no autonomOS record. The miss here is
    // what makes spawnAgent take the adopt branch (synthesize a new record).
    assert.equal(
      getAgentByProviderSessionId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      undefined,
    );
  });

  it("does not confuse the agent id with the providerSessionId (split-id)", () => {
    // Passing the AGENT id to the CC-id resolver must NOT match — the two are
    // distinct id-spaces for split-id records.
    const agentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ccId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    seedSplitIdAgent(agentId, ccId);
    assert.equal(getAgentByProviderSessionId(agentId), undefined);
  });
});

describe("external-cc-resume — id == providerSessionId invariant", () => {
  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-extresume-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("a unified-id agent resolves by the SAME id via both lookups", () => {
    // The footgun the invariant removes: for a unified-id agent there is only
    // one id, so whichever id a caller reaches for (agent id or CC session id)
    // resolves the same record. No "try one, 404, retry the other" dance.
    const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    seedUnifiedAgent(id);

    const byAgentId = getAgent(id as never);
    const byCcId = getAgentByProviderSessionId(id);
    assert.ok(byAgentId, "resolves via getAgent (agent id)");
    assert.ok(byCcId, "resolves via getAgentByProviderSessionId (CC id)");
    assert.equal(byAgentId?.id, byCcId?.id, "same record either way");
  });

  it("an adopted external session resolves by its CC id after adoption", () => {
    // Adopt reuses the external CC id as the agent id, so once adopted the raw
    // CC id directly resolves the managed record — Terry's "never hit it again".
    const ccId = "12121212-1212-4121-8121-121212121212";
    seedUnifiedAgent(ccId); // adopted record: id == providerSessionId == ccId

    assert.ok(
      getAgent(ccId as never),
      "getAgent(ccId) resolves the adopted agent",
    );
    assert.equal(getAgentByProviderSessionId(ccId)?.id, ccId);
  });

  it("adopted record persists across a cache reload (server restart)", () => {
    const ccId = "34343434-3434-4343-8343-343434343434";
    seedUnifiedAgent(ccId);

    // Simulate a restart: drop the in-memory cache, re-read from disk.
    _resetCacheForTesting();

    const found = getAgent(ccId as never);
    assert.ok(found, "adopted managed record survived the reload");
    assert.equal(found?.providerSessionId, ccId);
  });
});

/**
 * assertAdoptable — the two preconditions that keep an adopt from becoming a
 * silent empty session or an arbitrary file write. Pure and exported precisely
 * so these can be pinned without a PTY spawn.
 */
describe("external-cc-resume — assertAdoptable guard", () => {
  const CC = { hasResumableSession: () => true, displayName: "Claude Code" };
  const VALID = "d3efd88f-622c-4f4f-a170-e34b625f6c04";

  it("allows a Claude-Code-shaped provider with a UUID session id", () => {
    assert.doesNotThrow(() => assertAdoptable(CC, VALID));
  });

  it("REJECTS a provider with no hasResumableSession hook (Codex/Gemini)", () => {
    // Codex and Gemini declare no probe AND their buildArgs ignore
    // resumeSessionId (Codex resumes via providerThreadId), so adopting there
    // would spawn a FRESH session and report success — the exact silent failure
    // this path exists to prevent. ADR-056 scopes adopt to Claude Code; without
    // this guard that scope is a comment, not a control.
    for (const displayName of ["Codex", "Gemini CLI"]) {
      assert.throws(
        () => assertAdoptable({ displayName }, VALID),
        /cannot adopt an external session/,
        `${displayName} must be refused`,
      );
    }
  });

  it("REJECTS a non-UUID session id (it becomes the record's filename)", () => {
    // The adopted id is used as the agent id → `<agentsDir>/<id>.json`. `UUID` is
    // a bare string alias, so nothing but this check stands between a caller
    // (any spawned agent, via MCP create_agent) and a write outside that dir.
    for (const bad of [
      "../../../../tmp/pwn",
      "..",
      "not-a-uuid",
      "",
      "d3efd88f-622c-4f4f-a170",
      "d3efd88f_622c_4f4f_a170_e34b625f6c04",
      "/etc/passwd",
      "a/b",
    ]) {
      assert.throws(
        () => assertAdoptable(CC, bad),
        /invalid session id/,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  it("checks provider capability BEFORE id shape", () => {
    // Ordering matters for the error the user sees: an unsupported provider is
    // the more fundamental problem, and its message maps to 422 either way.
    assert.throws(
      () => assertAdoptable({ displayName: "Codex" }, "not-a-uuid"),
      /cannot adopt an external session/,
    );
  });

  it("accepts uppercase UUIDs (CC ids are case-insensitive hex)", () => {
    assert.doesNotThrow(() => assertAdoptable(CC, VALID.toUpperCase()));
  });
});
