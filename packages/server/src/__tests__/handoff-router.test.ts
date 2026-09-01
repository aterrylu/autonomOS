import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDelta, UUID } from "@autonomos/core";
import { HANDOFF_QUEUE_CAP } from "@autonomos/core";
import {
  _resetCacheForTesting,
  buildAgent,
  deleteAgentRaw,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { onAgentDelta } from "../events/agents.js";
import { type RouteMeta, routeMessage } from "../gateway/router.js";
import { listHandoffQueue } from "../handoffQueue.js";

function seedGemini(name: string): UUID {
  const id = randomUUID() as UUID;
  insertAgent(
    buildAgent({
      id,
      name,
      workingDirectory: "/tmp",
      provider: "gemini-cli",
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  return id;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handoff-router-"));
  _setConfigDirForTesting(dir);
  _resetCacheForTesting();
});
afterEach(() => {
  _resetConfigDirForTesting();
  _resetCacheForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe("routeMessage → manual-queue hand-off (Gemini)", () => {
  it("accepts (null) + notes 'queued' + enqueues + emits the pending count", async () => {
    const gigi = seedGemini("Gigi");
    const sender = seedGemini("Sender");
    const deltas: AgentDelta[] = [];
    const off = onAgentDelta((d) => deltas.push(d));

    const meta: RouteMeta = {};
    const err = await routeMessage(
      "agent://Gigi",
      "please review",
      sender,
      meta,
    );
    off();

    // A queued hand-off is an ACCEPT (null per ADR-064), not a failure — but the
    // note tells the sender it was queued, never "delivered".
    assert.equal(err, null);
    assert.match(meta.note ?? "", /queued for hand-delivery/i);
    assert.match(meta.note ?? "", /Gigi/);

    const items = listHandoffQueue(gigi);
    assert.equal(items.length, 1);
    assert.equal(items[0].message, "please review");
    assert.equal(items[0].from, "Sender");

    // A live pending-count delta was emitted so the badge updates without a refetch.
    const patch = deltas.find(
      (d) =>
        d.type === "agent.updated" &&
        d.id === gigi &&
        d.patch.pendingHandoffCount === 1,
    );
    assert.ok(
      patch,
      "expected an agent.updated patch with pendingHandoffCount:1",
    );
  });

  it("rejects past the cap as a real failure, leaving the queue at CAP", async () => {
    const gigi = seedGemini("Gigi");
    const sender = seedGemini("Sender");
    for (let i = 0; i < HANDOFF_QUEUE_CAP; i++) {
      assert.equal(await routeMessage("agent://Gigi", `m${i}`, sender), null);
    }
    const over = await routeMessage("agent://Gigi", "overflow", sender);
    assert.ok(
      typeof over === "string" && /queue full/i.test(over),
      `expected a queue-full error string, got ${JSON.stringify(over)}`,
    );
    assert.equal(listHandoffQueue(gigi).length, HANDOFF_QUEUE_CAP);
    assert.ok(!listHandoffQueue(gigi).some((i) => i.message === "overflow"));
  });

  it("refuses a self-send before it would queue anything", async () => {
    const gigi = seedGemini("Gigi");
    const err = await routeMessage("agent://Gigi", "hi me", gigi);
    assert.match(String(err), /yourself/i);
    assert.equal(listHandoffQueue(gigi).length, 0);
  });

  it("deleting the agent clears its queue — no orphan messages left on disk", async () => {
    const gigi = seedGemini("Gigi");
    const sender = seedGemini("Sender");
    await routeMessage("agent://Gigi", "queued", sender);
    assert.equal(listHandoffQueue(gigi).length, 1);

    // deleteAgentRaw is the chokepoint every delete path funnels through.
    assert.equal(deleteAgentRaw(gigi), true);
    assert.equal(
      listHandoffQueue(gigi).length,
      0,
      "the deleted agent's queued messages must be cleared, not orphaned",
    );
  });
});
