import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HANDOFF_QUEUE_CAP } from "@autonomos/core";

// ── Test isolation ─────────────────────────────────────────────
// handoffQueue.ts resolves QUEUE_DIR() from configDir.ts, which reads
// AUTONOMOS_CONFIG_DIR. Set it to an isolated temp dir BEFORE importing so the
// #350 configDir test-escape guard is satisfied (never touches ~/.autonomos).
const TEST_DIR = join(tmpdir(), `autonomos-handoff-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const {
  enqueueHandoff,
  listHandoffQueue,
  handoffQueueCount,
  removeHandoffItem,
  peekNextHandoff,
  clearHandoffQueue,
  agentsWithPendingHandoffs,
} = await import("../handoffQueue.js");

const QUEUE_DIR = join(TEST_DIR, "handoff-queues");
const AGENT = "b53282f5-42bd-4920-819b-1572341545e2"; // a UUID-shaped id

function queueFile(agentId: string): string {
  return join(QUEUE_DIR, `${agentId}.json`);
}

beforeEach(() => {
  rmSync(QUEUE_DIR, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("handoff queue store", () => {
  it("enqueues and lists oldest-first with server-set id + timestamp", () => {
    const before = Date.now();
    const r1 = enqueueHandoff(AGENT, { from: "TeamLead@a", message: "first" });
    const r2 = enqueueHandoff(AGENT, { from: "Peer@a", message: "second" });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (!r1.ok || !r2.ok) return; // narrow

    assert.equal(r1.count, 1);
    assert.equal(r2.count, 2);
    assert.notEqual(r1.item.id, r2.item.id);
    assert.ok(r1.item.enqueuedAt >= before && r1.item.enqueuedAt <= Date.now());

    const items = listHandoffQueue(AGENT);
    assert.deepEqual(
      items.map((i) => i.message),
      ["first", "second"],
    );
    assert.equal(items[0].from, "TeamLead@a");
  });

  it("caps the queue at HANDOFF_QUEUE_CAP and rejects the next as a real failure", () => {
    for (let i = 0; i < HANDOFF_QUEUE_CAP; i++) {
      const r = enqueueHandoff(AGENT, { from: "s", message: `m${i}` });
      assert.equal(r.ok, true, `enqueue ${i} within cap should succeed`);
    }
    assert.equal(handoffQueueCount(AGENT), HANDOFF_QUEUE_CAP);

    // The (CAP+1)th is rejected — ok:false, reason:"full", count stays at CAP.
    const over = enqueueHandoff(AGENT, { from: "s", message: "overflow" });
    assert.equal(over.ok, false);
    if (over.ok) return;
    assert.equal(over.reason, "full");
    assert.equal(over.count, HANDOFF_QUEUE_CAP);

    // The rejected message was NOT stored — the queue is unchanged.
    assert.equal(handoffQueueCount(AGENT), HANDOFF_QUEUE_CAP);
    assert.ok(!listHandoffQueue(AGENT).some((i) => i.message === "overflow"));

    // Removing one frees a slot — the boundary is not a permanent lock.
    const first = peekNextHandoff(AGENT);
    assert.ok(first);
    removeHandoffItem(AGENT, first.id);
    const after = enqueueHandoff(AGENT, { from: "s", message: "now-fits" });
    assert.equal(after.ok, true);
  });

  it("persists to disk — a fresh read (server restart) returns the queue", () => {
    const r = enqueueHandoff(AGENT, {
      from: "TeamLead@a",
      message: "survive me",
    });
    assert.equal(r.ok, true);

    // The file exists at the expected 0600 path and holds the item verbatim —
    // the store keeps no in-memory cache, so every read is a disk round-trip
    // (this is exactly what a restart would see).
    assert.ok(existsSync(queueFile(AGENT)));
    const onDisk = JSON.parse(readFileSync(queueFile(AGENT), "utf-8"));
    assert.equal(onDisk.agentId, AGENT);
    assert.equal(onDisk.items[0].message, "survive me");

    assert.equal(handoffQueueCount(AGENT), 1);
    assert.equal(listHandoffQueue(AGENT)[0].message, "survive me");
  });

  it("removeHandoffItem returns the removed item; unknown id is a no-op", () => {
    const r = enqueueHandoff(AGENT, { from: "s", message: "deliver me" });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    assert.equal(removeHandoffItem(AGENT, "no-such-id"), undefined);
    assert.equal(handoffQueueCount(AGENT), 1);

    const removed = removeHandoffItem(AGENT, r.item.id);
    assert.equal(removed?.message, "deliver me");
    assert.equal(handoffQueueCount(AGENT), 0);
  });

  it("deletes the file when the queue empties (no husk left behind)", () => {
    const r = enqueueHandoff(AGENT, { from: "s", message: "only one" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(existsSync(queueFile(AGENT)));

    removeHandoffItem(AGENT, r.item.id);
    assert.ok(
      !existsSync(queueFile(AGENT)),
      "empty queue must delete its file so the count derived from readdir is honest",
    );
    // Reading an absent queue is an empty queue, not an error.
    assert.deepEqual(listHandoffQueue(AGENT), []);
    assert.equal(handoffQueueCount(AGENT), 0);
  });

  it("agentsWithPendingHandoffs lists only agents with items, skipping corrupt files", () => {
    const a2 = randomUUID();
    enqueueHandoff(AGENT, { from: "s", message: "x" });
    enqueueHandoff(a2, { from: "s", message: "y" });
    const listed = agentsWithPendingHandoffs().sort();
    assert.deepEqual(listed.sort(), [AGENT, a2].sort());

    // clearHandoffQueue drops one; it disappears from the list.
    clearHandoffQueue(AGENT);
    assert.deepEqual(agentsWithPendingHandoffs(), [a2]);
  });

  it("rejects an unsafe agent id (path-traversal guard)", () => {
    assert.throws(() => enqueueHandoff("../evil", { from: "s", message: "m" }));
    assert.throws(() => listHandoffQueue("a/b"));
    assert.throws(() => handoffQueueCount("../../etc/passwd"));
  });
});
