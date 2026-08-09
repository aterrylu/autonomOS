import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _getPhaseForTesting,
  cancelPromptTracking,
  notePromptHookEvent,
  noteStartupSettled,
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
 *
 * SETTLE GATING (the 2026-08-08 redesign): no window arms until
 * noteStartupSettled — most tests call it right after tracking to model the
 * common "dialogs settle fast" boot; the gating-specific tests withhold it.
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
  retracted: string[] = [];
  ptyAlive = true;
  readonly io: Parameters<typeof trackPromptDelivery>[3];

  constructor() {
    let nextId = 0;
    this.io = {
      write: (data: string) => {
        if (!this.ptyAlive) return false;
        this.writes.push(data);
        return true;
      },
      notify: (message: string) => {
        this.notifications.push(message);
        return `pd-${++nextId}`;
      },
      retract: (id: string) => {
        this.retracted.push(id);
        return true;
      },
      sessionStartTimeoutMs: 50,
      promptSubmitTimeoutMs: 50,
      redeliverEnterDelayMs: 5,
      // Far above every window used here — the fallback must never be what
      // settles a test that models an explicit settle (or a withheld one).
      settleFallbackMs: 10_000,
      givenUpRetentionMs: 10_000,
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

  it("happy path — settle, SessionStart, UserPromptSubmit → no writes, tracking done", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "do the thing", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart", "startup");
    notePromptHookEvent(sid, "UserPromptSubmit");
    assert.equal(_getPhaseForTesting(sid), undefined, "tracker must be gone");
    await sleep(120); // no timer should ever fire — assert nothing happened
    assert.deepEqual(f.writes, [], "no PTY writes on the happy path");
    assert.deepEqual(f.notifications, []);
  });

  it("SETTLE GATING — no window arms before noteStartupSettled, however long the dialogs take", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    // Far past both 50ms windows — with the old spawn-anchored clocks this
    // is deep into "re-delivered + gave up" territory.
    await sleep(200);
    assert.deepEqual(f.writes, [], "no paste while dialogs may be up");
    assert.deepEqual(f.notifications, [], "no warning while dialogs may be up");
    assert.equal(_getPhaseForTesting(sid), "awaiting_prompt_submit");

    // Dialogs settle late → the submit window starts NOW; the receipt
    // machinery works exactly as if boot had been fast.
    noteStartupSettled(sid);
    await waitFor(() => f.writes.length === 2, "re-delivery after late settle");
  });

  it("SETTLE FALLBACK — with no watcher signal, tracking self-settles and still detects", async () => {
    const f = makeIO();
    f.io.settleFallbackMs = 30; // a wiring regression must not disable the detector
    trackPromptDelivery(sid, "test", "p", f.io);
    // No noteStartupSettled call at all: the fallback must arm the windows.
    await waitFor(
      () => f.notifications.length === 1,
      "no-SessionStart warning via the self-settle fallback",
    );
    assert.match(f.notifications[0], /never reported SessionStart/);
  });

  it("missing UserPromptSubmit → exactly one bracketed-paste re-delivery + Enter", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "do the thing", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart");
    await waitFor(() => f.writes.length === 2, "re-delivery paste + Enter");

    assert.equal(f.writes[0], "\x1b[200~do the thing\x1b[201~");
    assert.equal(f.writes[1], "\r");
    await waitFor(() => f.notifications.length === 1, "operator notification");

    // ONE retry only — even after another full timeout window, no more writes.
    await sleep(120);
    assert.equal(f.writes.length, 2, "never re-delivers a second time");
  });

  it("dedup guard — UserPromptSubmit arriving before the timer fires → no re-delivery", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
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
    noteStartupSettled(sid);
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
    noteStartupSettled(sid);
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
    assert.deepEqual(f.retracted, [], "nothing to retract on a clean confirm");
  });

  it("re-delivery also unconfirmed → failure notification, tracker parks as given_up", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart");
    // Re-delivery notice fires with the paste; failure notice fires after the
    // second window elapses unconfirmed.
    await waitFor(
      () => f.notifications.length === 2,
      "re-delivery notice + failure notice",
    );
    assert.equal(f.writes.length, 2);
    assert.equal(
      _getPhaseForTesting(sid),
      "given_up",
      "tracker lingers so a late receipt can retract",
    );
  });

  it("RETRACTION — a receipt after give-up withdraws the failure warning, not the factual re-delivery note", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart");
    await waitFor(() => _getPhaseForTesting(sid) === "given_up", "give-up");
    // notifications: [re-delivered (pd-1, factual), failure (pd-2, retractable)]
    notePromptHookEvent(sid, "UserPromptSubmit");
    assert.deepEqual(
      f.retracted,
      ["pd-2"],
      "only the failure claim is withdrawn",
    );
    assert.equal(_getPhaseForTesting(sid), undefined, "tracker done");
  });

  it("no SessionStart at all → warns, parks as given_up; a late SessionStart RESUMES tracking", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    await waitFor(
      () => f.notifications.length === 1,
      "no-SessionStart warning",
    );
    assert.deepEqual(f.writes, [], "no paste into a session that never booted");
    assert.equal(_getPhaseForTesting(sid), "given_up");

    // The session boots after all: the BOOT warning was premature (retract it)
    // — but SessionStart is not a delivery receipt, so tracking RESUMES with
    // the one-shot re-delivery still available. Finishing here would deny a
    // genuinely dropped prompt on evidence that proves only "it booted".
    notePromptHookEvent(sid, "SessionStart");
    assert.deepEqual(f.retracted, ["pd-1"], "boot warning retracted");
    assert.equal(_getPhaseForTesting(sid), "awaiting_prompt_submit");
    await waitFor(
      () => f.writes.length === 2,
      "re-delivery still fires if the prompt never submits",
    );
  });

  it("resumed tracking after a boot warning still confirms cleanly on a prompt submit", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    await waitFor(
      () => _getPhaseForTesting(sid) === "given_up",
      "boot give-up",
    );
    notePromptHookEvent(sid, "SessionStart");
    notePromptHookEvent(sid, "UserPromptSubmit"); // prompt was fine, just slow
    assert.equal(_getPhaseForTesting(sid), undefined);
    await sleep(120);
    assert.deepEqual(f.writes, [], "no paste for a slow-but-delivered prompt");
  });

  it("C1 REGRESSION — SessionStart before settle must not destroy the settle fallback", async () => {
    // spawn → SessionStart → settle NEVER arrives (wiring regression). The
    // fallback used to share the timer slot the SessionStart branch clears,
    // leaving the tracker timerless forever: no re-delivery, no warning — a
    // silently disabled detector in its most common ordering (hooks fire
    // within seconds; settle waits on the watcher's terminal state).
    const f = makeIO();
    f.io.settleFallbackMs = 30;
    trackPromptDelivery(sid, "test", "p", f.io);
    notePromptHookEvent(sid, "SessionStart");
    await waitFor(
      () => f.writes.length === 2,
      "fallback self-settles and the re-delivery still fires",
    );
  });

  it("given_up tracker is dropped after the retention window", async () => {
    const f = makeIO();
    f.io.givenUpRetentionMs = 40;
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    await waitFor(() => _getPhaseForTesting(sid) === "given_up", "give-up");
    await waitFor(
      () => _getPhaseForTesting(sid) === undefined,
      "retention expiry drops the tracker",
    );
    // After disposal a late receipt is a plain no-op — nothing to retract.
    notePromptHookEvent(sid, "UserPromptSubmit");
    assert.deepEqual(f.retracted, []);
  });

  it("compact SessionStart is ignored — only a boot SessionStart arms the receipt window", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart", "compact");
    assert.equal(_getPhaseForTesting(sid), "awaiting_session_start");
    notePromptHookEvent(sid, "SessionStart", "startup");
    assert.equal(_getPhaseForTesting(sid), "awaiting_prompt_submit");
  });

  it("dead PTY at re-delivery time → aborts without throwing, no Enter write", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart");
    f.ptyAlive = false;
    await sleep(120);
    assert.deepEqual(f.writes, []);
    assert.equal(_getPhaseForTesting(sid), undefined);
  });

  it("cancelPromptTracking stops everything — no re-delivery after kill", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
    notePromptHookEvent(sid, "SessionStart");
    cancelPromptTracking(sid);
    await sleep(120);
    assert.deepEqual(f.writes, []);
  });

  it("SessionEnd ends tracking — no re-delivery into a dying session", async () => {
    const f = makeIO();
    trackPromptDelivery(sid, "test", "p", f.io);
    noteStartupSettled(sid);
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
    noteStartupSettled(sid);
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

  it("events for untracked sessions are a no-op (settle included)", () => {
    notePromptHookEvent("never-tracked", "UserPromptSubmit");
    notePromptHookEvent("never-tracked", "SessionStart");
    noteStartupSettled("never-tracked");
    assert.equal(_getPhaseForTesting("never-tracked"), undefined);
  });

  it("multi-line prompts survive inside one bracketed paste", async () => {
    const f = makeIO();
    const prompt = "line one\nline two\nline three";
    trackPromptDelivery(sid, "test", prompt, f.io);
    noteStartupSettled(sid);
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

/**
 * The settle fallback and the watcher's hard deadline are defined in different
 * modules with a load-bearing ordering: the fallback must fire only AFTER any
 * default-configured watcher has reached its terminal state, or windows would
 * arm while startup dialogs are genuinely still being fought — the exact
 * false-warning class ADR-074 removed. Pin the relation so "raise the watcher
 * deadline for slow hosts" cannot silently flip it.
 */
describe("settle fallback stays above the watcher deadline", () => {
  it("SETTLE_FALLBACK_MS > DEFAULT_STARTUP_WATCHER_TIMEOUT_MS", async () => {
    const { SETTLE_FALLBACK_MS } = await import("../agents/promptDelivery.js");
    const { DEFAULT_STARTUP_WATCHER_TIMEOUT_MS } = await import(
      "../providers/claude-code.js"
    );
    assert.ok(SETTLE_FALLBACK_MS > DEFAULT_STARTUP_WATCHER_TIMEOUT_MS);
  });
});
