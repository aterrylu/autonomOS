import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { UUID } from "@autonomos/core";
import {
  _registerSyntheticAttachment,
  _unregisterSyntheticAttachment,
} from "../agents/runtime.js";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import {
  _resetHandoffDeliveryForTesting,
  injectAllHandoffs,
  injectHandoffItem,
  noteHandoffDelivery,
} from "../handoffDelivery.js";
import { enqueueHandoff, listHandoffQueue } from "../handoffQueue.js";
import { FakePty } from "../perf/fake-pty.js";

const registered: UUID[] = [];

function seedGemini(
  name: string,
  withPty = true,
): { id: UUID; writes: string[] } {
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
  const writes: string[] = [];
  if (withPty) {
    // A real-shaped IPty (asIPty wires onData, which the attachment needs),
    // with write overridden to capture what the injector sends.
    const pty = new FakePty().asIPty();
    pty.write = (d: string) => {
      writes.push(d);
    };
    _registerSyntheticAttachment(id, pty);
    registered.push(id);
  }
  return { id, writes };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handoff-deliv-"));
  _setConfigDirForTesting(dir);
  _resetCacheForTesting();
  _resetHandoffDeliveryForTesting();
});
afterEach(() => {
  for (const id of registered.splice(0)) _unregisterSyntheticAttachment(id);
  _resetHandoffDeliveryForTesting();
  _resetConfigDirForTesting();
  _resetCacheForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe("hand-off delivery — inject + hook-correlated receipt", () => {
  it("injects into the PTY and dequeues ONLY on the UserPromptSubmit receipt", () => {
    const { id, writes } = seedGemini("Gigi");
    const enq = enqueueHandoff(id, {
      from: "TeamLead",
      message: "please review",
    });
    assert.ok(enq.ok);
    if (!enq.ok) return;

    assert.deepEqual(injectHandoffItem(id, enq.item.id), { ok: true });

    // A bracketed-paste carrying the message + its provenance reached the PTY.
    const paste = writes.find((w) => w.includes("please review"));
    assert.ok(paste, "expected a bracketed-paste write of the message");
    assert.ok(paste.startsWith("\x1b[200~"), "must be a bracketed paste");
    assert.match(paste, /TeamLead/);

    // The item is STILL queued — injection alone is not a receipt.
    assert.equal(listHandoffQueue(id).length, 1);

    // The receipt (UserPromptSubmit) dequeues it.
    noteHandoffDelivery(id, "UserPromptSubmit");
    assert.equal(listHandoffQueue(id).length, 0);
  });

  it("does NOT dequeue on a non-confirming event", () => {
    const { id } = seedGemini("Gigi");
    const enq = enqueueHandoff(id, { from: "s", message: "m" });
    assert.ok(enq.ok);
    if (!enq.ok) return;
    injectHandoffItem(id, enq.item.id);

    noteHandoffDelivery(id, "PreToolUse");
    assert.equal(
      listHandoffQueue(id).length,
      1,
      "only a confirming event (UserPromptSubmit) is a receipt",
    );
  });

  it("allows only one in-flight injection at a time", () => {
    const { id } = seedGemini("Gigi");
    const a = enqueueHandoff(id, { from: "s", message: "a" });
    const b = enqueueHandoff(id, { from: "s", message: "b" });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    assert.deepEqual(injectHandoffItem(id, a.item.id), { ok: true });
    assert.equal(
      injectHandoffItem(id, b.item.id).ok,
      false,
      "a second injection must wait for the first receipt",
    );
  });

  it("send-all drains the queue one at a time, each gated on its receipt", () => {
    const { id, writes } = seedGemini("Gigi");
    enqueueHandoff(id, { from: "s", message: "first" });
    enqueueHandoff(id, { from: "s", message: "second" });

    assert.deepEqual(injectAllHandoffs(id), { ok: true });
    assert.ok(writes.some((w) => w.includes("first")));
    assert.ok(
      !writes.some((w) => w.includes("second")),
      "the second must not inject until the first is confirmed",
    );
    assert.equal(listHandoffQueue(id).length, 2);

    noteHandoffDelivery(id, "UserPromptSubmit"); // first receipt
    assert.equal(listHandoffQueue(id).length, 1);
    assert.ok(writes.some((w) => w.includes("second")));

    noteHandoffDelivery(id, "UserPromptSubmit"); // second receipt
    assert.equal(listHandoffQueue(id).length, 0);
  });

  it("refuses injection when the agent has no live PTY", () => {
    const { id } = seedGemini("NoPty", false);
    const enq = enqueueHandoff(id, { from: "s", message: "m" });
    assert.ok(enq.ok);
    if (!enq.ok) return;
    assert.equal(injectHandoffItem(id, enq.item.id).ok, false);
    assert.equal(listHandoffQueue(id).length, 1, "the message stays queued");
  });
});
