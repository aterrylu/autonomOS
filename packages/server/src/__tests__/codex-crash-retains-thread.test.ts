/**
 * Codex crash-net thread retention (ADR-100, extending ADR-049).
 *
 * The release-gating bug: a Codex agent that crashed while resuming had its
 * providerThreadId CLEARED by the onExit safety net and was force-respawned
 * fresh — severing the ONLY link between the agent and its (still-on-disk)
 * rollout, so the conversation could only be recovered from a backup. The fix
 * (see resume-fresh-fallback.test.ts) stops the destructive net from arming on a
 * bare providerThreadId, so a Codex resume-crash falls through to the normal
 * exit path: markExited("crashed").
 *
 * These tests pin the RETAIN half of the guarantee at the store boundary — a
 * crashed Codex agent KEEPS its providerThreadId (and its record), so it stays
 * revivable via `codex resume <threadId>`. Together with the "net does not arm"
 * unit tests, they cover the full chain: net doesn't fire → markExited →
 * retained + thread intact. Synthetic ids/names only.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { UUID } from "@autonomos/core";

// UNCONDITIONAL (not ??=): a worker agent inherits AUTONOMOS_CONFIG_DIR=<real
// dir>, and the #350 guard makes the store throw rather than touch it — so pin
// an isolated, per-run config dir before importing the store.
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-codex-crash-retain-${randomUUID()}`;

const {
  buildAgent,
  insertAgent,
  patchAgent,
  getAgent,
  markExited,
  _resetCacheForTesting,
} = await import("../agents/store.js");

/** A running Codex agent mid-conversation: it has a providerThreadId, so on disk
 *  its rollout lives under that thread. This is the exact shape that used to get
 *  its thread cleared on an immediate resume-crash. */
function seedRunningCodexWithThread(threadId: string): string {
  const id = randomUUID();
  insertAgent(
    buildAgent({
      id: id as UUID,
      name: "codex-worker-a",
      workingDirectory: "/tmp/proj",
      provider: "codex",
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  // providerThreadId isn't a buildAgent field — set it the way codexControl does.
  patchAgent(id as UUID, { providerThreadId: threadId });
  return id;
}

beforeEach(() => _resetCacheForTesting());
afterEach(() => _resetCacheForTesting());

describe("Codex crash-net — a crashed agent stays resumable (ADR-100)", () => {
  it("markExited('crashed') RETAINS the record with providerThreadId intact", () => {
    const tid = "77777777-7777-4777-8777-777777777777";
    const id = seedRunningCodexWithThread(tid);

    const updated = markExited(id as UUID, "crashed");

    assert.ok(updated, "the record is retained, not deleted");
    assert.equal(updated?.status, "exited");
    assert.equal(updated?.exitReason, "crashed");
    // THE GUARANTEE: the thread id survives the crash, so `codex resume <tid>`
    // can revive the conversation — its rollout is still on disk under <tid>.
    assert.equal(updated?.providerThreadId, tid);
  });

  it("the retained record is still queryable (did not vanish from the fleet)", () => {
    const tid = "88888888-8888-4888-8888-888888888888";
    const id = seedRunningCodexWithThread(tid);

    markExited(id as UUID, "crashed");

    const fetched = getAgent(id as UUID);
    assert.ok(fetched, "still in the store");
    assert.equal(fetched?.status, "exited");
    assert.equal(fetched?.providerThreadId, tid);
  });

  it("identity fields are unchanged, so a resume reattaches THIS record (not a duplicate)", () => {
    const tid = "99999999-9999-4999-8999-999999999999";
    const id = seedRunningCodexWithThread(tid);

    markExited(id as UUID, "crashed");

    const fetched = getAgent(id as UUID);
    // id + providerSessionId stable → resume reattaches this record;
    // providerThreadId present → it resumes the real conversation.
    assert.equal(fetched?.id, id);
    assert.equal(fetched?.providerSessionId, id);
    assert.equal(fetched?.provider, "codex");
  });
});
