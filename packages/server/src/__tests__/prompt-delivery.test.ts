import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _getPhaseForTesting,
  cancelPromptTracking,
  notePromptHookEvent,
  _resetForTesting as resetPromptDelivery,
  supportsPromptDeliveryReceipt,
  trackPromptDelivery,
} from "../agents/promptDelivery.js";
import { getProvider } from "../providers/index.js";

/**
 * Unit coverage for the prompt-delivery receipt state machine. Uses real
 * timers with millisecond-scale timeouts injected through the IO options.
 *
 * Timing discipline (why this file was deflaked): the state machine's effects
 * (paste/Enter writes, notifications, phase transitions) land from *timer*
 * callbacks. A fixed `await sleep(N)` before asserting the effect had happened
 * raced the callback under full-suite load — the callback could be scheduled
 * past N ms, so the assertion ran too early and intermittently failed. So we
 * POLL for the expected effect ({@link waitFor}) instead of sleeping a guessed
 * duration. Waits that assert an effect must NOT happen (e.g. "no second
 * re-delivery", "no write into a cancelled session") still sleep a bounded
 * window and then assert absence — those can't false-fail from load, only a
 * real regression makes them red.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` until it's true, or throw after `timeoutMs`. Replaces
 * `sleep(guess)` for any assertion that an effect HAS happened: it returns the
 * instant the effect is observed (fast + load-independent) rather than betting
 * on a fixed delay. The 1s cap is far above any real callback latency, so a
 * genuine hang still fails the test promptly-ish with a clear message.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms waiting for: ${what}`,
      );
    }
    await sleep(2);
  }
}

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
    await sleep(120); // no timer should ever fire — assert nothing happened
    assert.deepEqual(f.writes, [], "no PTY writes on the happy path");
    assert.deepEqual(f.notifications, []);
  });

  it("missing UserPromptSubmit → exactly one bracketed-paste re-delivery + Enter", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "do the thing", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await waitFor(() => f.writes.length === 2, "re-delivery paste + Enter");

    assert.equal(f.writes[0], "\x1b[200~do the thing\x1b[201~");
    assert.equal(f.writes[1], "\r");
    await waitFor(() => f.notifications.length === 1, "operator notification");

    // ONE retry only — even after another full timeout window, no more writes.
    await sleep(120);
    assert.equal(f.writes.length, 2, "never re-delivers a second time");
    await waitFor(
      () => _getPhaseForTesting(sid) === undefined,
      "tracker finished after the post-redelivery window",
    );
  });

  it("dedup guard — UserPromptSubmit arriving before the timer fires → no re-delivery", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    // Note the submit immediately — deterministically inside the timeout window,
    // regardless of load (a prior `sleep(20)` could overrun 50ms under load and
    // let the re-delivery timer fire first).
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
    // Wait until the re-delivery has fully written (paste + Enter) so the submit
    // below lands in the post-Enter confirm phase, not the paste→Enter gap.
    await waitFor(
      () => f.writes.length === 2,
      "re-delivery paste + Enter done",
    );
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
    // Re-delivery notice fires with the paste; failure notice fires after the
    // second window elapses unconfirmed.
    await waitFor(
      () => f.notifications.length === 2,
      "re-delivery notice + failure notice",
    );
    assert.equal(f.writes.length, 2);
    await waitFor(() => _getPhaseForTesting(sid) === undefined, "tracker done");
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
    // Wait until the boot window has expired and tracking gave up, then a late
    // SessionStart must be a no-op.
    await waitFor(
      () => _getPhaseForTesting(sid) === undefined,
      "boot window expired, tracking gave up",
    );
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
    // Widen the paste→Enter gap generously so the confirming submit deterministically
    // lands inside it even under load (a tight gap raced the Enter timer).
    f.io.redeliverEnterDelayMs = 200;
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await waitFor(
      () => f.writes.length === 1,
      "paste written, Enter still pending",
    );
    notePromptHookEvent(sid, "UserPromptSubmit"); // original delivery confirms late, inside the gap
    await waitFor(
      () => f.writes.length === 2,
      "pending Enter replaced by draft-clear",
    );
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
    await waitFor(() => f.writes.length === 2, "multi-line paste + Enter");
    assert.equal(f.writes[0], `\x1b[200~${prompt}\x1b[201~`);
    assert.equal(f.writes[1], "\r");
  });
});

/**
 * The receipt is HOOK-RELAY-shaped: SessionStart, UserPromptSubmit and the
 * activity events that cancel the fallback all arrive through hooks. Tracking a
 * provider that emits none guarantees the timeout fires — Codex derived status
 * from its app-server event stream instead, so every prompted Codex agent
 * logged "may have failed to boot" and pushed a SystemWarning, on agents that
 * had already executed their prompt correctly. That false alarm misdirected a
 * live investigation, so the gate is pinned here against the REAL provider
 * capability objects rather than a hand-written fixture.
 */
describe("prompt-delivery receipt applies only to providers with a hook relay", () => {
  it("is skipped for Codex — zero hook events means no receipt can ever arrive", () => {
    const codex = getProvider("codex");
    assert.equal(codex.capabilities.hooks.eventCount, 0);
    assert.equal(supportsPromptDeliveryReceipt(codex.capabilities), false);
  });

  it("is applied for every provider that does emit hook events", () => {
    for (const name of ["claude-code", "gemini-cli"]) {
      const provider = getProvider(name);
      assert.ok(
        provider.capabilities.hooks.eventCount > 0,
        `${name} should have a hook relay`,
      );
      assert.equal(
        supportsPromptDeliveryReceipt(provider.capabilities),
        true,
        `${name} must keep its delivery receipt`,
      );
    }
  });

  it("keys off the capability, not the provider name", () => {
    // If Codex ever ships hooks, it starts being tracked with no code change.
    const codex = getProvider("codex");
    assert.equal(
      supportsPromptDeliveryReceipt({
        ...codex.capabilities,
        hooks: { ...codex.capabilities.hooks, eventCount: 4 },
      }),
      true,
    );
  });
});
