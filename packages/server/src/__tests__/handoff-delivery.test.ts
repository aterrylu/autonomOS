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
  _setHandoffTimingsForTesting,
  injectAllHandoffs,
  injectHandoffItem,
  noteHandoffDelivery,
} from "../handoffDelivery.js";
import { enqueueHandoff, listHandoffQueue } from "../handoffQueue.js";
import { FakePty } from "../perf/fake-pty.js";
import { delay } from "./helpers/wait.js";

const ENTER_DELAY = 5;
/** Wait past the (shrunk) Enter delay so the receipt is ARMED. */
const untilArmed = () => delay(ENTER_DELAY + 15);

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
  _setHandoffTimingsForTesting({ enterDelayMs: ENTER_DELAY });
});
afterEach(() => {
  for (const id of registered.splice(0)) _unregisterSyntheticAttachment(id);
  _resetHandoffDeliveryForTesting();
  _setHandoffTimingsForTesting(); // restore production timings
  _resetConfigDirForTesting();
  _resetCacheForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe("hand-off delivery — inject + hook-correlated receipt", () => {
  it("injects into the PTY and dequeues ONLY on an ARMED UserPromptSubmit receipt", async () => {
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

    // Still queued — injection alone is not a receipt.
    assert.equal(listHandoffQueue(id).length, 1);

    await untilArmed(); // the Enter fires → the receipt is armed
    noteHandoffDelivery(id, "UserPromptSubmit");
    assert.equal(listHandoffQueue(id).length, 0);
  });

  it("does NOT treat a UserPromptSubmit that arrives BEFORE the Enter as a receipt (finding 1)", async () => {
    const { id } = seedGemini("Gigi");
    const enq = enqueueHandoff(id, { from: "s", message: "m" });
    assert.ok(enq.ok);
    if (!enq.ok) return;
    injectHandoffItem(id, enq.item.id);

    // A stray UserPromptSubmit in the paste→Enter window (a prior turn's late
    // hook, or the human typing) must NOT dequeue an unsubmitted message.
    noteHandoffDelivery(id, "UserPromptSubmit");
    assert.equal(
      listHandoffQueue(id).length,
      1,
      "an unarmed receipt must not dequeue",
    );

    // Once armed, the real receipt dequeues.
    await untilArmed();
    noteHandoffDelivery(id, "UserPromptSubmit");
    assert.equal(listHandoffQueue(id).length, 0);
  });

  it("does NOT dequeue on a non-confirming event", async () => {
    const { id } = seedGemini("Gigi");
    const enq = enqueueHandoff(id, { from: "s", message: "m" });
    assert.ok(enq.ok);
    if (!enq.ok) return;
    injectHandoffItem(id, enq.item.id);
    await untilArmed();

    noteHandoffDelivery(id, "PreToolUse");
    assert.equal(
      listHandoffQueue(id).length,
      1,
      "only a confirming event (UserPromptSubmit) is a receipt",
    );
  });

  it("releases the in-flight lock on SessionEnd without dequeuing (finding 5)", async () => {
    const { id } = seedGemini("Gigi");
    const enq = enqueueHandoff(id, { from: "s", message: "m" });
    assert.ok(enq.ok);
    if (!enq.ok) return;
    injectHandoffItem(id, enq.item.id);
    await untilArmed();

    noteHandoffDelivery(id, "SessionEnd");
    // Not delivered — the message stays queued...
    assert.equal(listHandoffQueue(id).length, 1);
    // ...and the lock is released, so a fresh injection is accepted again.
    assert.deepEqual(injectHandoffItem(id, enq.item.id), { ok: true });
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

  it("send-all drains the queue one at a time, each gated on its receipt", async () => {
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

    await untilArmed();
    noteHandoffDelivery(id, "UserPromptSubmit"); // first receipt → injects second
    assert.equal(listHandoffQueue(id).length, 1);
    assert.ok(writes.some((w) => w.includes("second")));

    await untilArmed();
    noteHandoffDelivery(id, "UserPromptSubmit"); // second receipt → empty
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

  it("cancels the Enter timer when the lock is released — no orphaned CR on the next injection (nox review)", async () => {
    const { id, writes } = seedGemini("Gigi");
    const a = enqueueHandoff(id, { from: "s", message: "alpha" });
    const b = enqueueHandoff(id, { from: "s", message: "bravo" });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    injectHandoffItem(id, a.item.id); // A's Enter armed for +ENTER_DELAY
    noteHandoffDelivery(id, "SessionEnd"); // releases the lock → cancels A's Enter
    injectHandoffItem(id, b.item.id); // B injected fresh
    await untilArmed(); // both A's (cancelled) and B's Enter windows elapse

    // Only B's Enter should reach the PTY. A's orphaned timer, left armed, would
    // submit B's paste early + unarmed and leave B stuck-but-delivered.
    assert.equal(
      writes.filter((w) => w === "\r").length,
      1,
      "A's released Enter timer must not also fire",
    );
    // B is properly armed, so its receipt dequeues B cleanly.
    noteHandoffDelivery(id, "UserPromptSubmit");
    assert.equal(listHandoffQueue(id).length, 1, "B delivered; A still queued");
  });

  it("strips the paste terminator + CR from agent content so paste-mode can't be escaped (nox review)", () => {
    const { id, writes } = seedGemini("Gigi");
    const enq = enqueueHandoff(id, {
      from: "ev\x1b[201~il",
      message: "hi\x1b[201~\rinjected",
    });
    assert.ok(enq.ok);
    if (!enq.ok) return;
    injectHandoffItem(id, enq.item.id);

    const paste = writes.find((w) => w.startsWith("\x1b[200~"));
    assert.ok(paste);
    // Exactly ONE terminator — the wrapper's closing \x1b[201~, none from content.
    assert.equal(
      paste.split("\x1b[201~").length - 1,
      1,
      "content-embedded paste terminators must be stripped",
    );
    assert.ok(!paste.includes("\r"), "bare CR must be stripped from content");
  });
});
