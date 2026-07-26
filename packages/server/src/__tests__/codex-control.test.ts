import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetCodexControlForTesting,
  _setCodexTimingsForTesting,
  deliverToCodex,
  disposeCodexControl,
  formatInbound,
  setCodexInboundNotifier,
  startCodexStatusWatch,
} from "../gateway/codexControl.js";
import {
  captureLogs,
  delay,
  type FakeCodexDaemon,
  installFakeCodexDaemon,
  waitUntil,
} from "./helpers/fake-codex-daemon.js";

/**
 * Codex inbound is injected as an attributed user turn into the agent's
 * app-server daemon, mirroring Claude Code's channel formatting
 * (`[Name → you via agent://Name]\n<text>`) so the fleet reads consistently.
 */
describe("codex inbound formatting", () => {
  it("wraps the message with sender attribution + URI, CC-style", () => {
    const out = formatInbound(
      "Bar@autonomOS",
      "agent://Bar@autonomOS",
      "can you review PR #42?",
    );
    assert.equal(
      out,
      "[Bar@autonomOS → you via agent://Bar@autonomOS]\ncan you review PR #42?",
    );
  });

  it("preserves multi-line message bodies", () => {
    const out = formatInbound("X", "agent://X", "line1\nline2");
    assert.ok(out.startsWith("[X → you via agent://X]\n"));
    assert.ok(out.endsWith("line1\nline2"));
  });
});

/**
 * Inbound delivery is idle-gated: a `turn/start` mid-turn interleaves with the
 * running turn, so messages queue until the daemon reports the thread idle.
 * That is correct — but it used to happen in COMPLETE SILENCE, for up to 15
 * minutes per attempt and ~45 minutes before any operator-visible signal. From
 * the outside, "queued behind a long turn" and "silently dropped" produced
 * byte-identical logs, and a correctly-queued message was duly reported as a
 * lost message. These tests pin the signals that tell the two apart.
 */
describe("codex inbound delivery observability", () => {
  const AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const ENDPOINT = "ws://127.0.0.1:1/fake";
  let installed: FakeCodexDaemon | null = null;

  /** Install the fake daemon and register it for teardown. Returns a non-null
   *  handle so tests can use it inside closures without re-narrowing. */
  function startDaemon(): FakeCodexDaemon {
    installed = installFakeCodexDaemon();
    return installed;
  }

  afterEach(() => {
    // Tests that deliberately leave a message queued print a real
    // "DROPPING N undelivered inbound message(s)" line here, after captureLogs
    // has restored console.log. That is the dispose-path warning working as
    // designed on a still-queued message — expected output, not a failure.
    _resetCodexControlForTesting();
    installed?.restore();
    installed = null;
  });

  it("logs the enqueue — with char count and depth, never the message body", async () => {
    const daemon = startDaemon();
    daemon.status = "idle";
    _setCodexTimingsForTesting({ idlePollMs: 5, statusPollMs: 50 });
    const secret = "wire-transfer code 8842";

    const logs = await captureLogs(async (lines) => {
      deliverToCodex(AGENT, ENDPOINT, secret);
      // Wait on the LOG, not on daemon.injected: the fake records the turn when
      // it RECEIVES turn/start, while the controller logs only after the reply
      // resolves. Polling the daemon returns during that gap, so the assertion
      // raced the log under full-suite load (green alone, red in `make check`).
      await waitUntil(
        () => lines.some((l) => l.includes(`${AGENT.slice(0, 8)} injected`)),
        "the injection log",
      );
    });

    assert.ok(
      logs.some((l) =>
        l.includes(
          `${AGENT.slice(0, 8)} queued (${secret.length} chars, queue=1)`,
        ),
      ),
      `expected an enqueue log, got:\n${logs.join("\n")}`,
    );
    assert.ok(
      logs.some((l) => l.includes(`${AGENT.slice(0, 8)} injected`)),
      "expected the injection log to survive",
    );
    // Log hygiene: inbound can carry sensitive text — ids and counts only.
    assert.ok(
      !logs.some((l) => l.includes(secret)),
      "message body must never be logged",
    );
    assert.deepEqual(daemon.injected, [secret]);
  });

  it("logs every expired drain attempt when the thread never goes idle", async () => {
    const daemon = startDaemon();
    daemon.status = "active"; // a turn that starts and never finishes
    _setCodexTimingsForTesting({
      idlePollMs: 5,
      idleDeadlineMs: 80,
      retryBackoffMs: 5_000, // long: keep this test to a single attempt
      statusPollMs: 50,
    });

    const logs = await captureLogs(async (lines) => {
      deliverToCodex(AGENT, ENDPOINT, "are you still there?");
      // Poll for the line rather than sleeping a guessed budget — 400ms is the
      // ceiling here, not the trigger.
      await waitUntil(
        () =>
          lines.some(
            (l) =>
              l.includes("no idle window in") &&
              l.includes("thread still active") &&
              l.includes("1 queued, retrying"),
          ),
        "the drain deadline-expiry log",
        400,
      );
    });

    assert.ok(logs.length > 0);
    assert.equal(daemon.injected.length, 0, "must not inject mid-turn");
  });

  it("distinguishes an unreadable thread from a busy one", async () => {
    const daemon = startDaemon();
    daemon.failThreadRead = true; // daemon up, thread unreadable
    _setCodexTimingsForTesting({
      idlePollMs: 5,
      idleDeadlineMs: 500,
      retryBackoffMs: 5_000,
      statusPollMs: 50,
    });

    const logs = await captureLogs(async (lines) => {
      deliverToCodex(AGENT, ENDPOINT, "hello?");
      await waitUntil(
        () => lines.some((l) => l.includes("thread status unreadable")),
        "the unreadable-status log",
        300,
      );
    });

    // The CAUSE must be named — "socket closed", "timed out" and "no rollout
    // for thread" all surface as unreadable but have different remedies.
    assert.ok(
      logs.some((l) => l.includes("thread status unreadable (no rollout")),
      `expected the failure cause in the log, got:\n${logs.join("\n")}`,
    );
    assert.ok(
      !logs.some((l) => l.includes("thread still active")),
      "an unreadable thread must not be reported as busy",
    );
  });

  it("notifies the operator once when a message waits too long behind a turn", async () => {
    const daemon = startDaemon();
    daemon.status = "active";
    _setCodexTimingsForTesting({
      idlePollMs: 5,
      queueWaitWarnMs: 40,
      idleDeadlineMs: 5_000, // stay inside one drain attempt
      statusPollMs: 50,
    });
    const notes: string[] = [];
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      deliverToCodex(AGENT, ENDPOINT, "ping");
      await waitUntil(
        () => notes.length > 0,
        "an operator notification",
        1_000,
      );
      // Keep polling well past the threshold — the warning must not repeat.
      await delay(150);
    });

    assert.equal(notes.length, 1, `warn once, got ${notes.length}`);
    assert.match(notes[0], /queued for/);
    assert.match(notes[0], /hasn't finished/);
    assert.match(notes[0], /1 message\(s\) waiting/);
  });

  it("does not re-warn for each backlogged message once the stall clears", async () => {
    // The warn-once flag belongs to the CONTROLLER, not the message. Per-message
    // it re-fired for every queued item the instant the stall ENDED — each one
    // inherits an old queuedAt, so it trips the threshold on its first poll —
    // burying the operator in "its current turn hasn't finished" at the exact
    // moment delivery was succeeding.
    const daemon = startDaemon();
    daemon.status = "active";
    _setCodexTimingsForTesting({
      idlePollMs: 5,
      queueWaitWarnMs: 40,
      idleDeadlineMs: 5_000,
      statusPollMs: 50,
    });
    const notes: string[] = [];
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      for (const text of ["one", "two", "three"]) {
        deliverToCodex(AGENT, ENDPOINT, text);
      }
      await waitUntil(() => notes.length > 0, "the stall warning", 1_000);
      daemon.status = "idle"; // the wedged turn finishes
      await waitUntil(
        () => daemon.injected.length === 3,
        "the whole backlog delivered",
      );
      await delay(100);
    });

    assert.deepEqual(daemon.injected, ["one", "two", "three"]);
    assert.equal(
      notes.length,
      1,
      `one warning per stall episode, got ${notes.length}:\n${notes.join("\n")}`,
    );
  });

  it("reports undelivered messages when the agent is terminated — the one real drop", async () => {
    // dispose() empties the queue. Doing that silently reproduces the exact
    // symptom this file logs against ("queued (N chars)" then nothing forever),
    // except here the message really is gone and nobody is coming back for it.
    const daemon = startDaemon();
    daemon.status = "active"; // keep the message queued
    _setCodexTimingsForTesting({
      idlePollMs: 5,
      idleDeadlineMs: 5_000,
      statusPollMs: 50,
    });
    const notes: string[] = [];
    setCodexInboundNotifier((_id, message) => notes.push(message));

    const logs = await captureLogs(async (lines) => {
      deliverToCodex(AGENT, ENDPOINT, "please review PR #42");
      await waitUntil(
        () => lines.some((l) => l.includes("queued (")),
        "the enqueue log",
      );
      disposeCodexControl(AGENT); // agent killed while the message is queued
      await delay(50);
    });

    assert.ok(
      logs.some(
        (l) =>
          l.includes("DROPPING 1 undelivered inbound message(s)") &&
          l.includes("agent terminated"),
      ),
      `expected a drop log, got:\n${logs.join("\n")}`,
    );
    assert.equal(
      notes.length,
      1,
      "the operator must be told about a real drop",
    );
    assert.match(notes[0], /never delivered/);
    assert.ok(
      !logs.some((l) => l.includes("please review PR #42")),
      "message body must never be logged, not even when dropped",
    );
    assert.equal(daemon.injected.length, 0);
  });

  it("delivers as soon as the turn finishes — the queue is a delay, not a drop", async () => {
    const daemon = startDaemon();
    daemon.status = "active";
    _setCodexTimingsForTesting({
      idlePollMs: 5,
      idleDeadlineMs: 5_000,
      statusPollMs: 50,
    });

    await captureLogs(async () => {
      deliverToCodex(AGENT, ENDPOINT, "first");
      deliverToCodex(AGENT, ENDPOINT, "second");
      await delay(60);
      assert.equal(daemon.injected.length, 0, "nothing injected while active");
      daemon.status = "idle";
      await waitUntil(
        () => daemon.injected.length === 2,
        "both messages delivered",
      );
    });

    assert.deepEqual(daemon.injected, ["first", "second"]);
  });
});

/**
 * Two escalation paths that were unreachable or one-shot. Both are BEHAVIOR,
 * not logging, which is why they get their own coverage: a notification that
 * can never fire is indistinguishable from a healthy system.
 */
describe("codex control escalation", () => {
  const AGENT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const ENDPOINT = "ws://127.0.0.1:1/fake";
  let installed: FakeCodexDaemon | null = null;

  afterEach(() => {
    _resetCodexControlForTesting();
    installed?.restore();
    installed = null;
  });

  it("warns when the daemon accepts the socket but never answers thread/read", async () => {
    // The regression: queryIdle swallows read failures and returns null, so the
    // statusLoop catch never ran and `statusFailures` reset to 0 every cycle —
    // the "status feed unreadable" warning could NEVER fire for the likeliest
    // daemon failure of all, and the dashboard would freeze silently in the
    // reconciler built to prevent exactly that.
    installed = installFakeCodexDaemon();
    installed.failThreadRead = true; // socket fine, reads fail
    _setCodexTimingsForTesting({ statusPollMs: 10, idlePollMs: 5 });
    const notes: string[] = [];
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      await waitUntil(
        () => notes.length > 0,
        "the status-feed-unreadable notification",
        3_000,
      );
    });

    assert.match(notes[0], /Live status for this Codex agent is unavailable/);
  });

  it("re-notifies the stale-status warning on a backoff, not once per lifetime", async () => {
    // Same one-shot flaw the delivery path had: `=== FAILURES_BEFORE_WARN` warned
    // exactly once, so a daemon still unreachable much later went silent. The
    // status reconciler now escalates on a doubling backoff like noteFailure.
    installed = installFakeCodexDaemon();
    installed.failThreadRead = true;
    _setCodexTimingsForTesting({ statusPollMs: 5, idlePollMs: 5 });
    const notes: string[] = [];
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      // 3rd failure warns, then 6th — a strict equality would stop at one.
      await waitUntil(
        () => notes.length >= 2,
        "a SECOND stale-status notification",
        3_000,
      );
    });

    assert.ok(
      notes.length >= 2,
      `expected re-notification, got ${notes.length}`,
    );
    for (const n of notes)
      assert.match(n, /Live status for this Codex agent is unavailable/);
  });

  it("re-notifies on a backoff instead of once per controller lifetime", async () => {
    // `=== FAILURES_BEFORE_WARN` meant an agent wedged at hour 0 produced ONE
    // warning; at hour 6, with a deeper queue, nothing re-raised and the queue
    // depth in the original text was frozen at its failure-#3 value.
    installed = installFakeCodexDaemon();
    installed.threadIds = []; // no thread ever appears -> drain keeps failing
    _setCodexTimingsForTesting({
      threadWaitMs: 20,
      threadPollMs: 5,
      retryBackoffMs: 10,
      statusPollMs: 5_000, // keep the status loop out of this test
    });
    const notes: string[] = [];
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      deliverToCodex(AGENT, ENDPOINT, "nobody home");
      await waitUntil(
        () => notes.length >= 2,
        "a SECOND notification after further failures",
        5_000,
      );
    });

    assert.ok(
      notes.length >= 2,
      `expected re-notification, got ${notes.length}`,
    );
    for (const n of notes) assert.match(n, /aren't being delivered/);
  });
});
