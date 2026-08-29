import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetCodexControlForTesting,
  _setCodexTimingsForTesting,
  deliverToCodex,
  disposeCodexControl,
  formatInbound,
  setCodexActivitySink,
  setCodexInboundNotifier,
  setCodexStatusSink,
  startCodexStatusWatch,
} from "../gateway/codexControl.js";
import {
  captureLogs,
  type FakeCodexDaemon,
  installFakeCodexDaemon,
} from "./helpers/fake-codex-daemon.js";
import { delay, settlesWithin, waitUntil } from "./helpers/wait.js";

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
 * Inbound delivery is IMMEDIATE, including into a busy thread — Codex delivers
 * at its own turn boundaries, so the idle gate that used to sit here was both
 * unnecessary and the cause of a `wait_agent` deadlock (ADR-060 reverses
 * ADR-057's untested assumption). What remains behind the injection is a retry
 * buffer for genuine TRANSPORT failures.
 *
 * These tests pin the SIGNALS on those paths. The failure this file exists
 * against is not a dropped message but an indistinguishable one: a queue that
 * says nothing produces logs byte-identical to a silent drop, which is how a
 * correctly-queued message was duly reported as lost.
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
    _setCodexTimingsForTesting({ statusPollMs: 50 });
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

  it("reports undelivered messages when the agent is terminated — the one real drop", async () => {
    // dispose() empties the queue. Doing that silently reproduces the exact
    // symptom this file logs against ("queued (N chars)" then nothing forever),
    // except here the message really is gone and nobody is coming back for it.
    const daemon = startDaemon();
    // Hold the message in the queue with a real TRANSPORT failure — a daemon
    // whose TUI never created a thread. A busy thread no longer holds anything
    // back, which is the point of the gate removal.
    daemon.threadIds = [];
    _setCodexTimingsForTesting({ threadPollMs: 5, statusPollMs: 50 });
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

  it("injects immediately into a BUSY thread — the idle gate is gone", async () => {
    // The behavior this replaced: delivery used to wait for a confirmed-idle
    // window. That gate was unnecessary (Codex delivers at its own turn
    // boundaries) and it deadlocked an agent blocked in `collaboration.
    // wait_agent`, which reads as `active` — so we withheld the very message
    // that would have released it.
    const daemon = startDaemon();
    daemon.status = "active"; // never goes idle for the duration of this test
    _setCodexTimingsForTesting({ statusPollMs: 50 });

    await captureLogs(async () => {
      deliverToCodex(AGENT, ENDPOINT, "first");
      deliverToCodex(AGENT, ENDPOINT, "second");
      await waitUntil(
        () => daemon.injected.length === 2,
        () =>
          `both messages delivered while active (saw ${daemon.injected.length})`,
      );
    });

    assert.deepEqual(daemon.injected, ["first", "second"]);
    assert.equal(daemon.status, "active", "the thread never went idle");
  });

  it("does not hold inbound forever on a STALE compacting status", async () => {
    // The wedge the compacting skip could otherwise create: `lastStatus` is a
    // CACHE fed by daemon pushes and the status poll. Report compacting, then
    // break `thread/read` so the poll can never refresh it — the "compaction
    // finished" push is gone and we are a non-creator, so it is never replayed.
    // Without a bound the message queues forever, logging every few seconds,
    // and the only notification says the DASHBOARD may be stale — pointing the
    // operator at cosmetics while every message they send is swallowed.
    const daemon = startDaemon();
    daemon.status = "compacting";
    _setCodexTimingsForTesting({
      statusPollMs: 10,
      retryBackoffMs: 10,
      compactingMaxHoldMs: 60,
    });
    const seen: string[] = [];
    const notes: string[] = [];
    setCodexStatusSink((_id, status) => seen.push(status));
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      await waitUntil(
        () => seen.includes("compacting"),
        () => `the status feed to report compacting (saw ${seen.join(",")})`,
      );
      daemon.failThreadRead = true; // the status can never refresh again
      deliverToCodex(AGENT, ENDPOINT, "do not swallow me");
      await waitUntil(
        () => daemon.injected.length === 1,
        () =>
          `delivery once the stale hold is bounded (injected ${daemon.injected.length})`,
      );
    });

    assert.deepEqual(daemon.injected, ["do not swallow me"]);
    // Match something UNIQUE to the fail-open branch. `/may be stale/` also
    // appears in statusLoop's "the dashboard status may be stale" warning,
    // which fires within ~30ms of failThreadRead — before the bound expires —
    // so it would satisfy this assertion whether or not the branch ever ran.
    assert.ok(
      notes.some((n) => /Delivering anyway/.test(n)),
      `the operator must be told we stopped believing the status, got:\n${notes.join("\n")}`,
    );
  });

  it("drains a whole backlog once it stops believing a stale compacting status", async () => {
    // The bound has to protect the QUEUE, not just its head. Clearing the clock
    // on fail-open re-armed a full hold for each following message, so a 5-deep
    // backlog drained one message per bound — 5 waits and 5 identical "status
    // may be stale" notifications. The decision is about the reported STATUS,
    // so it latches until that status actually changes.
    const daemon = startDaemon();
    daemon.status = "compacting";
    _setCodexTimingsForTesting({
      statusPollMs: 10,
      retryBackoffMs: 10,
      compactingMaxHoldMs: 60,
    });
    const seen: string[] = [];
    const notes: string[] = [];
    setCodexStatusSink((_id, status) => seen.push(status));
    setCodexInboundNotifier((_id, message) => notes.push(message));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      await waitUntil(
        () => seen.includes("compacting"),
        () => `the status feed to report compacting (saw ${seen.join(",")})`,
      );
      daemon.failThreadRead = true; // the status can never refresh again
      for (const text of ["one", "two", "three"])
        deliverToCodex(AGENT, ENDPOINT, text);
      await waitUntil(
        () => daemon.injected.length === 3,
        () => `the whole backlog (injected ${daemon.injected.length})`,
        3_000,
      );
    });

    assert.deepEqual(daemon.injected, ["one", "two", "three"]);
    assert.equal(
      notes.filter((n) => /Delivering anyway/.test(n)).length,
      1,
      `one fail-open notification per EPISODE, got:\n${notes.join("\n")}`,
    );
  });

  it("holds delivery only while COMPACTING, then delivers", async () => {
    // The one state we still refuse to inject into. This is untested
    // conservatism rather than a measured requirement — nothing was determined
    // about compaction — so it is deliberately cheap: a window that ends on its
    // own, with the retry picking the message up. This test pins that it is a
    // DELAY and not a drop.
    const daemon = startDaemon();
    daemon.status = "compacting";
    _setCodexTimingsForTesting({ statusPollMs: 10, retryBackoffMs: 10 });

    await captureLogs(async () => {
      // Wait until the controller has actually OBSERVED "compacting", not
      // merely until the daemon was asked. The fake counts a read when it
      // RECEIVES the request, which is before the reply lands and the status is
      // recorded — polling that counter races the very state under test.
      const seen: string[] = [];
      setCodexStatusSink((_id, status) => seen.push(status));
      startCodexStatusWatch(AGENT, ENDPOINT);
      await waitUntil(
        () => seen.includes("compacting"),
        () => `the status feed to report compacting (saw ${seen.join(",")})`,
      );
      deliverToCodex(AGENT, ENDPOINT, "during compaction");
      await delay(60);
      assert.equal(
        daemon.injected.length,
        0,
        "must not inject while the thread is compacting",
      );
      daemon.status = "idle";
      await waitUntil(
        () => daemon.injected.length === 1,
        () => `delivery once compaction ends (saw ${daemon.injected.length})`,
      );
    });

    assert.deepEqual(daemon.injected, ["during compaction"]);
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
    _setCodexTimingsForTesting({ statusPollMs: 10 });
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
    _setCodexTimingsForTesting({ statusPollMs: 5 });
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

/**
 * The DELIVERY PROMISE contract (ADR-064). `deliverToCodex` settles only on a
 * terminal outcome, and the router's ack is built directly on that — so a
 * settle that never fires, or fires with the wrong verdict, is a sender told
 * the opposite of the truth.
 *
 * The teardown path is the one most easily got wrong: `dispose()` clears the
 * queue, and before ADR-064 that was the ONLY place a message left the queue
 * without anyone being told. Its senders would have waited out the full ack
 * window and been told "still retrying" about a message that was already gone.
 */
describe("codex inbound — the delivery promise settles on terminal outcomes", () => {
  const AGENT = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
  const ENDPOINT = "ws://127.0.0.1:1/fake";

  afterEach(() => {
    _resetCodexControlForTesting();
  });

  it("settles a queued message as terminated when the agent is disposed", async () => {
    // deliverToCodex enqueues SYNCHRONOUSLY (the Promise executor runs inline),
    // so the message is provably on the queue when dispose lands — no race, and
    // no sleep needed to make this deterministic.
    let pending!: Promise<unknown>;
    const logs = await captureLogs(async () => {
      pending = deliverToCodex(AGENT, ENDPOINT, "you will never read this");
      disposeCodexControl(AGENT);
    });

    assert.deepEqual(
      await settlesWithin(pending, "the disposed agent's queued message"),
      { delivered: false, reason: "the agent was terminated" },
      "the sender must learn the outcome, not wait out its ack window",
    );
    // The operator-facing half of the same event. Both must fire: the log is
    // the durable record (the notification lands in an in-memory store a
    // shutdown destroys microseconds later — see runtime.ts).
    assert.ok(
      logs.some((l) => /DROPPING 1 undelivered/.test(l)),
      `the drop must also be logged, got: ${JSON.stringify(logs)}`,
    );
  });

  it("builds a live replacement controller after a dispose, and settles through it", async () => {
    // NAMED FOR WHAT IT ACTUALLY COVERS. It was first written as "settles an
    // enqueue onto an already-disposed controller" and mutation testing proved
    // that false: removing the settle from `enqueue`'s disposed branch left this
    // GREEN. `getOrCreate` treats a disposed controller as ABSENT and builds a
    // fresh one, so a post-dispose deliverToCodex never reaches that branch —
    // it is only reachable in the race `deliverToCodex` documents (a kill
    // landing between resolving the controller and enqueueing onto it), which
    // cannot be driven from outside the module.
    //
    // So that branch is NOT covered here, and this comment says so rather than
    // letting the test name imply it. What IS covered is the property that
    // makes a respawn work: after dispose, the next delivery reaches a LIVE
    // controller instead of no-oping against the dead one — which is what stops
    // a killed agent from poisoning its own replacement.
    //
    // That property is held by TWO redundant mechanisms — `disposeCodexControl`
    // deletes the registry entry, and `getOrCreate` separately treats a disposed
    // controller as absent — so NO SINGLE MUTATION turns this red; either
    // mechanism alone still passes. Proving it non-vacuous took defeating both
    // at once (it does go red then). Recorded because a future reader running a
    // single mutation would otherwise conclude this test asserts nothing.
    let first!: Promise<unknown>;
    await captureLogs(async () => {
      first = deliverToCodex(AGENT, ENDPOINT, "first");
      disposeCodexControl(AGENT);
    });
    assert.equal(
      (await settlesWithin(first, "the first message")) !== undefined,
      true,
    );

    // A second delivery builds a FRESH controller (the disposed one is treated
    // as absent) — so this asserts the replacement is live and independent,
    // which is what stops a killed agent from poisoning its own respawn.
    let second!: Promise<unknown>;
    const logs = await captureLogs(async () => {
      second = deliverToCodex(AGENT, ENDPOINT, "second");
      disposeCodexControl(AGENT);
    });
    assert.deepEqual(await settlesWithin(second, "the second message"), {
      delivered: false,
      reason: "the agent was terminated",
    });
    // Anchor on the agent-id prefix, NOT a bare /queued \(6 chars/. The
    // disposed branch logs "<id> NOT queued (6 chars) — agent was terminated",
    // which CONTAINS "queued (6 chars" — so the loose form passed against a
    // mutant that reused the dead controller, i.e. it asserted the opposite of
    // its own intent. Mutation testing is the only reason this was caught.
    const enqueued = `${AGENT.slice(0, 8)} queued (6 chars`;
    assert.ok(
      logs.some((l) => l.includes(enqueued)),
      `the second message must reach a LIVE controller (expected "${enqueued}"), got: ${JSON.stringify(logs)}`,
    );
  });
});

/**
 * Codex has no hook relay, so its `lastActivityAt` used to freeze at spawn
 * (Terry's "the date is the BIRTH date, not last-active" bug). The gateway's
 * status-watch client is a NON-creator of the thread, so it never sees
 * turn/item events — the only activity signal is the busy/idle status feed
 * (thread/status/changed + the periodic thread/read poll). So "working" is our
 * evidence of work: it advances activity on every observation (the poll is the
 * mid-turn signal), and the working→idle transition forces the turn-boundary
 * flush. Compacting is housekeeping and must NOT count.
 */
describe("codex activity → lastActivityAt (#351)", () => {
  const AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const ENDPOINT = "ws://127.0.0.1:1/fake";
  let installed: FakeCodexDaemon | null = null;
  function startDaemon(): FakeCodexDaemon {
    installed = installFakeCodexDaemon();
    return installed;
  }
  afterEach(() => {
    _resetCodexControlForTesting();
    installed?.restore();
    installed = null;
  });

  it("advances activity per poll while working, then flushes at the working→idle turn boundary", async () => {
    const daemon = startDaemon();
    daemon.status = "active";
    _setCodexTimingsForTesting({ statusPollMs: 5 });
    const marks: { flush: boolean }[] = [];
    setCodexActivitySink((_id, _ts, flush) => marks.push({ flush }));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      // Working re-emits every poll → repeated non-flush marks. This is the
      // 10s-poll mid-turn liveness (shrunk to 5ms), our stand-in for the
      // per-item events a non-creator subscriber never receives.
      await waitUntil(
        () => marks.filter((m) => !m.flush).length >= 2,
        () => `two working activity marks (saw ${marks.length})`,
      );
      daemon.status = "idle"; // turn ends
      await waitUntil(
        () => marks.some((m) => m.flush),
        () =>
          `a flush at the working→idle boundary (saw ${JSON.stringify(marks)})`,
      );
    });

    assert.ok(
      marks.filter((m) => !m.flush).length >= 2,
      "working advanced activity on every poll",
    );
    assert.equal(
      marks.filter((m) => m.flush).length,
      1,
      "exactly one forced flush — the working→idle turn boundary, not idle-staying",
    );
  });

  it("does NOT mark activity for a compacting agent (housekeeping, not work)", async () => {
    const daemon = startDaemon();
    daemon.status = "compacting";
    _setCodexTimingsForTesting({
      statusPollMs: 5,
      compactingMaxHoldMs: 60_000,
    });
    const statuses: string[] = [];
    const marks: unknown[] = [];
    setCodexStatusSink((_id, s) => statuses.push(s));
    setCodexActivitySink((_id, _ts, flush) => marks.push({ flush }));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      await waitUntil(
        () => statuses.filter((s) => s === "compacting").length >= 2,
        () => `compacting observed twice (saw ${statuses.join(",")})`,
      );
    });

    assert.equal(
      marks.length,
      0,
      "compacting must never advance lastActivityAt",
    );
  });

  it("never marks activity for an agent that only idles — the birth-date invariant", async () => {
    // The load-bearing invariant behind Terry's bug: a never-working codex agent
    // (thread/started → emitStatus("idle") with prev===null, then idle→idle poll
    // re-emits) must produce ZERO activity marks. A lifecycle idle counting as
    // work is the exact regression — it would make lastActivityAt spuriously
    // fresh for an agent that has done nothing.
    const daemon = startDaemon();
    daemon.status = "idle";
    _setCodexTimingsForTesting({ statusPollMs: 5 });
    const statuses: string[] = [];
    const marks: unknown[] = [];
    setCodexStatusSink((_id, s) => statuses.push(s));
    setCodexActivitySink((_id, _ts, flush) => marks.push({ flush }));

    await captureLogs(async () => {
      startCodexStatusWatch(AGENT, ENDPOINT);
      await waitUntil(
        () => statuses.filter((s) => s === "idle").length >= 3,
        () => `idle observed 3× (saw ${statuses.join(",")})`,
      );
    });

    assert.equal(
      marks.length,
      0,
      "a never-working (idle) agent must never advance lastActivityAt",
    );
  });
});
