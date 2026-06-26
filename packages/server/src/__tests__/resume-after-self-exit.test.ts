import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isExitReason } from "@autonomos/core";
import {
  _resetCacheForTesting,
  buildAgent,
  deleteAgentRaw,
  getAgent,
  insertAgent,
  markExited,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

/**
 * Regression: resume after self_exit must succeed.
 *
 * The resume path (spawnAgent with `resumeAgentId`, agents/runtime.ts) looks
 * the agent up with `getAgent(id)` and throws `resumeAgentId "<id>" not found`
 * when it returns undefined. The bug: `self_exit` issued a hard DELETE that
 * rmSync'd the record off disk, so the lookup failed.
 *
 * The fix routes `self_exit` through the soft-exit path (POST /:id/kill →
 * killAttachment → markExited("self_exited")), which KEEPS the record. These
 * tests pin the store-level invariant that resume depends on: a self-exited
 * agent stays findable across an in-memory + on-disk reload, while the old
 * DELETE path (deleteAgentRaw) is what made it disappear.
 */

let isolatedDir: string;

function seedRunningAgent(id: string) {
  return insertAgent(
    buildAgent({
      id: id as never,
      name: "Worker",
      workingDirectory: "/tmp",
      provider: "claude-code",
      providerSessionId: "11111111-1111-1111-1111-111111111111",
      autonomousMode: false,
    }),
  );
}

describe("resume after self_exit — store invariant", () => {
  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-resume-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("keeps a self-exited record findable so resume can attach", () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    seedRunningAgent(id);

    // Soft-exit path (what /:id/kill → killAttachment now does for self_exit).
    const exited = markExited(id as never, "self_exited");
    assert.ok(exited, "markExited returned the record");
    assert.equal(exited?.status, "exited");
    assert.equal(exited?.exitReason, "self_exited");

    // The resume lookup (runtime.ts: getAgent(resumeAgentId)) still resolves —
    // and the providerSessionId is preserved so CC can --resume the session.
    const found = getAgent(id as never);
    assert.ok(found, "getAgent finds the self-exited record (no 'not found')");
    assert.equal(found?.providerSessionId, exited?.providerSessionId);
  });

  it("survives a cache reload from disk (server restart)", () => {
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    seedRunningAgent(id);
    markExited(id as never, "self_exited");

    // Simulate a restart: drop the in-memory cache, re-read from disk.
    _resetCacheForTesting();

    const found = getAgent(id as never);
    assert.ok(found, "record persisted on disk after self_exit (not rmSync'd)");
    assert.equal(found?.exitReason, "self_exited");
  });

  it("documents the old bug: the hard-DELETE path is what broke resume", () => {
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    seedRunningAgent(id);

    // The pre-fix self_exit path: DELETE /:id → deleteAgentRaw → rmSync.
    assert.equal(deleteAgentRaw(id as never), true);

    // Now getAgent returns undefined — exactly the input that makes
    // spawnAgent throw `resumeAgentId "<id>" not found`.
    assert.equal(getAgent(id as never), undefined);
  });
});

describe("isExitReason — /:id/kill reason-body validation", () => {
  it("accepts every member of the ExitReason union", () => {
    assert.equal(isExitReason("user_killed"), true);
    assert.equal(isExitReason("self_exited"), true);
    assert.equal(isExitReason("crashed"), true);
  });

  it("rejects unknown / malformed values so they default to user_killed", () => {
    // A typo, an empty body, a null JSON body, and non-string shapes all fall
    // through to the route's "user_killed" default (and get logged, not
    // silently coerced) rather than being written as a bogus exitReason.
    for (const bad of [
      "self_exit",
      "banana",
      "",
      undefined,
      null,
      42,
      {},
      ["crashed"],
    ]) {
      assert.equal(
        isExitReason(bad),
        false,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });
});
