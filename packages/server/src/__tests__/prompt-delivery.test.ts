import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _getPhaseForTesting,
  cancelPromptTracking,
  notePromptHookEvent,
  _resetForTesting as resetPromptDelivery,
  trackPromptDelivery,
} from "../agents/promptDelivery.js";

/**
 * Unit coverage for the prompt-delivery receipt state machine. Uses real
 * timers with millisecond-scale timeouts injected through the IO options —
 * deterministic without fake-timer plumbing.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

class FakeIO {
  writes: string[] = [];
  notifications: string[] = [];
  ptyAlive = true;
  readonly io: Parameters<typeof trackPromptDelivery>[3];

  constructor() {
    this.io = {
      write: (data: string) => {
        if (!this.ptyAlive) return false;
        this.writes.push(data);
        return true;
      },
      notify: (message: string) => {
        this.notifications.push(message);
      },
      sessionStartTimeoutMs: 50,
      promptSubmitTimeoutMs: 50,
      redeliverEnterDelayMs: 5,
    };
  }
}

function makeIO(): FakeIO {
  return new FakeIO();
}

describe("prompt delivery receipt tracking", () => {
  const sid = "pd-test-session";

  afterEach(() => {
    resetPromptDelivery();
  });

  it("happy path — SessionStart then UserPromptSubmit → no writes, tracking done", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "do the thing", f.io);
    notePromptHookEvent(sid, "SessionStart", "startup");
    notePromptHookEvent(sid, "UserPromptSubmit");
    assert.equal(_getPhaseForTesting(sid), undefined, "tracker must be gone");
    await sleep(120);
    assert.deepEqual(f.writes, [], "no PTY writes on the happy path");
    assert.deepEqual(f.notifications, []);
  });

  it("missing UserPromptSubmit → exactly one bracketed-paste re-delivery + Enter", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "do the thing", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(70); // past promptSubmitTimeout (50ms) + enter delay (5ms)

    assert.equal(f.writes.length, 2, "paste + Enter");
    assert.equal(f.writes[0], "\x1b[200~do the thing\x1b[201~");
    assert.equal(f.writes[1], "\r");
    assert.equal(f.notifications.length, 1, "operator notification fired");

    // ONE retry only — even after another full timeout window, no more writes.
    await sleep(120);
    assert.equal(f.writes.length, 2, "never re-delivers a second time");
    assert.equal(
      _getPhaseForTesting(sid),
      undefined,
      "tracker finished after the post-redelivery window",
    );
  });

  it("dedup guard — UserPromptSubmit arriving before the timer fires → no re-delivery", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(20); // inside the window
    notePromptHookEvent(sid, "UserPromptSubmit");
    await sleep(120);
    assert.deepEqual(f.writes, []);
  });

  it("activity guard — tool use without UserPromptSubmit also cancels re-delivery", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    notePromptHookEvent(sid, "PreToolUse");
    await sleep(120);
    assert.deepEqual(
      f.writes,
      [],
      "a session that is demonstrably working must not get a paste",
    );
  });

  it("re-delivery confirmed — UserPromptSubmit after the paste finishes tracking cleanly", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(70); // re-delivery fired
    assert.equal(_getPhaseForTesting(sid), "awaiting_redelivery_confirm");
    notePromptHookEvent(sid, "UserPromptSubmit");
    assert.equal(_getPhaseForTesting(sid), undefined);
    await sleep(120);
    assert.equal(f.writes.length, 2, "still just the one paste + Enter");
    assert.equal(f.notifications.length, 1, "no failure notification");
  });

  it("re-delivery also unconfirmed → failure notification, then done", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(150); // re-delivery + second window both elapse
    assert.equal(f.writes.length, 2);
    assert.equal(
      f.notifications.length,
      2,
      "re-delivery notice + failure notice",
    );
    assert.equal(_getPhaseForTesting(sid), undefined);
  });

  it("no SessionStart at all → warns and gives up without ever writing", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    await sleep(150); // past sessionStartTimeout + would-be submit windows
    assert.deepEqual(f.writes, [], "no paste into a session that never booted");
    assert.equal(_getPhaseForTesting(sid), undefined);
  });

  it("late SessionStart after the boot window → no re-delivery (tracking already over)", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    await sleep(70);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(120);
    assert.deepEqual(f.writes, []);
  });

  it("compact SessionStart is ignored — only a boot SessionStart arms the receipt window", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart", "compact");
    assert.equal(_getPhaseForTesting(sid), "awaiting_session_start");
    notePromptHookEvent(sid, "SessionStart", "startup");
    assert.equal(_getPhaseForTesting(sid), "awaiting_prompt_submit");
  });

  it("dead PTY at re-delivery time → aborts without throwing, no Enter write", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    f.ptyAlive = false;
    await sleep(120);
    assert.deepEqual(f.writes, []);
    assert.equal(_getPhaseForTesting(sid), undefined);
  });

  it("cancelPromptTracking stops everything — no re-delivery after kill", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    cancelPromptTracking(sid);
    await sleep(120);
    assert.deepEqual(f.writes, []);
  });

  it("SessionEnd ends tracking — no re-delivery into a dying session", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    notePromptHookEvent(sid, "SessionEnd");
    assert.equal(_getPhaseForTesting(sid), undefined);
    await sleep(120);
    assert.deepEqual(f.writes, []);
  });

  it("confirming event during the paste→Enter gap abandons the paste and clears the draft", async () => {
    const f = makeIO();
    f.io.redeliverEnterDelayMs = 40; // widen the gap so the event can land inside it
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(60); // paste written, Enter still pending
    assert.equal(f.writes.length, 1, "paste only so far");
    notePromptHookEvent(sid, "UserPromptSubmit"); // original delivery confirms late
    await sleep(80);
    assert.deepEqual(
      f.writes,
      ["\x1b[200~p\x1b[201~", "\x15"],
      "the pending Enter is cancelled and the input draft cleared (Ctrl-U)",
    );
  });

  it("events for untracked sessions are a no-op", () => {
    notePromptHookEvent("never-tracked", "UserPromptSubmit");
    notePromptHookEvent("never-tracked", "SessionStart");
    assert.equal(_getPhaseForTesting("never-tracked"), undefined);
  });

  it("multi-line prompts survive inside one bracketed paste", async () => {
    const f = makeIO();
    const prompt = "line one\nline two\nline three";
    trackPromptDelivery(sid, "test", prompt, f.io);
    notePromptHookEvent(sid, "SessionStart");
    await sleep(120);
    assert.equal(f.writes[0], `\x1b[200~${prompt}\x1b[201~`);
    assert.equal(f.writes[1], "\r");
  });
});
