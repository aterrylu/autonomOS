/**
 * Codex inbound delivery — INTEGRATION, across the seam where the bug lived.
 *
 * WHY THIS EXISTS. Every other test of this path is unit-level and stubs one
 * end of the seam: `gateway-router.test.ts` drives the real router and the real
 * store but can never reach a live Codex daemon, and `codex-control.test.ts`
 * drives the real controller against a fake GLOBAL WebSocket, with no router or
 * store above it. The message that was reported lost in forge QA (#287) did not
 * fail inside any one of those pieces — each was individually correct. It failed
 * in the COMPOSITION:
 *
 *     routeMessage → store lookup → getAgentSidecarEndpoint → deliverToCodex
 *                                                           → real socket
 *
 * No unit test can see that class of defect. This suite runs the whole chain for
 * real and fakes only what is on the far side of the socket: a real WebSocket
 * server on a real ephemeral loopback port, speaking the Codex app-server's
 * JSON-RPC (see `helpers/real-codex-daemon.ts`).
 *
 * NO `codex` BINARY. Codex is installed in no CI workflow, and adding that
 * dependency would make this suite skippable — exactly the property that let the
 * gap survive. It runs unconditionally on every `make check`.
 *
 * WHAT IS ASSERTED — the INVARIANT, never the mechanism. "A message routed to a
 * running Codex agent results in a `turn/start` reaching its daemon", and "a
 * transport failure is visible rather than silently successful". Nothing here
 * asserts HOW delivery is scheduled — not queueing, not idle windows, not drain
 * passes. That is deliberate: the idle gate is being removed, and a test written
 * at the invariant level passes before and after, which is what makes it a
 * regression net for that change instead of a cast of it.
 *
 * NOTE on `HOME`: the sender's display name resolves through `batchGetTitles`,
 * which stats `$HOME/.claude/projects/...`. It is a read-only, deterministic
 * miss (the sender id is minted per test and no transcript exists for it), so
 * the name always falls back to the store record. Left un-isolated to match
 * `gateway-router.test.ts`; verified to change nothing under an empty HOME.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _registerSyntheticAttachment,
  _unregisterSyntheticAttachment,
  getLiveAgentIds,
} from "../agents/runtime.js";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
  markExited,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import {
  _resetCodexControlForTesting,
  _setCodexTimingsForTesting,
  setCodexInboundNotifier,
} from "../gateway/codexControl.js";
import { routeMessage } from "../gateway/router.js";
import { FakePty } from "../perf/fake-pty.js";
import {
  type RealCodexDaemon,
  startRealCodexDaemon,
} from "./helpers/real-codex-daemon.js";
import { delay, waitUntil } from "./helpers/wait.js";

const SENDER_NAME = "Dispatcher";

/** A port nothing can be listening on, so a dial is DETERMINISTICALLY refused.
 *  `pickFreePort()` would model the same dead-endpoint scenario but leaves the
 *  port unowned — anything binding it in the window before we dial would turn
 *  a refusal into a 30s RPC timeout and an unreproducible red CI run. */
const DEAD_ENDPOINT = "ws://127.0.0.1:1";

let isolatedDir: string;
let senderId: string;
let daemon: RealCodexDaemon;
let daemons: RealCodexDaemon[];
let notifications: { agentId: string; message: string }[];

/** Start a daemon and register it for teardown. */
async function startDaemon(): Promise<RealCodexDaemon> {
  const d = await startRealCodexDaemon();
  daemons.push(d);
  return d;
}

function seedAgent(
  id: string,
  name: string,
  provider: "codex" | "claude-code",
): void {
  insertAgent(
    buildAgent({
      id,
      name,
      workingDirectory: "/tmp",
      provider,
      providerSessionId: id,
      permissionMode: "default",
    }),
  );
}

/** Seed a running Codex agent whose app-server daemon is up at `endpoint` —
 *  the state a real spawn leaves behind. Returns the agent id. */
function seedCodexAgent(name: string, endpoint = daemon.endpoint): string {
  const id = randomUUID();
  seedAgent(id, name, "codex");
  _registerSyntheticAttachment(id, new FakePty().asIPty(), {
    sidecarEndpoint: endpoint,
  });
  return id;
}

/** Assert a healthy delivery raised no operator alarm. An operator who learns
 *  the delivery warning fires on healthy traffic will ignore the one that
 *  matters, so alarm-fatigue regressions are in scope for a suite whose whole
 *  thesis is signal quality. */
function assertNoAlarm(): void {
  assert.deepEqual(
    notifications,
    [],
    "a successful delivery must not alarm the operator",
  );
}

beforeEach(async () => {
  isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-codex-integ-"));
  _setConfigDirForTesting(isolatedDir);
  _resetCacheForTesting();
  _resetCodexControlForTesting();
  // Poll CADENCES only, shrunk so a real socket round-trip is the slow part
  // rather than a production-tuned interval. This call is the ONLY thing the
  // idle-gate removal changed in this suite — `idlePollMs` went with the gate.
  // Not one assertion moved, which is what it means for a net to be written at
  // the invariant level rather than cast around the mechanism.
  _setCodexTimingsForTesting({
    threadPollMs: 20,
    threadWaitMs: 200,
    retryBackoffMs: 20,
    statusPollMs: 50,
  });
  notifications = [];
  setCodexInboundNotifier((agentId, message) =>
    notifications.push({ agentId, message }),
  );
  daemons = [];
  daemon = await startDaemon();
  senderId = randomUUID();
  seedAgent(senderId, SENDER_NAME, "claude-code");
});

afterEach(async () => {
  // Let in-flight replies land before tearing down. A test's wait ends the
  // moment the DAEMON records the turn, which is a beat before the client
  // processes the reply and clears its queue head — so an immediate teardown
  // logs "DROPPING 1 undelivered inbound message(s)" for a message that was in
  // fact delivered. Cosmetic only: no assertion depends on this, and a short
  // settle is only ever less alarming output, never a different verdict.
  await delay(50);
  // Controllers first: each holds an open socket to a daemon and a status loop
  // that would otherwise keep re-dialing a listener we are about to close.
  _resetCodexControlForTesting();
  // Read the AUTHORITATIVE list rather than a locally-kept array of what this
  // suite registered. Nothing here spawns, so every live attachment is
  // synthetic by construction — and a mirror of that list is one an added
  // registration can silently desync, leaking an endpoint into the next test.
  for (const id of getLiveAgentIds()) _unregisterSyntheticAttachment(id);
  // allSettled, not all: a close that times out must not skip the cleanup
  // below, and its reason has to survive to the assertions.
  const closes = await Promise.allSettled(daemons.map((d) => d.close()));
  // Collected AFTER close, because close() itself records into `errors` (a
  // socket that refuses to close). Snapshotting before it would leave that
  // path writing to an array nothing ever reads — a fault log that is itself
  // silent, which is the exact defect this suite exists to catch.
  const harnessFaults = daemons.flatMap((d) => d.errors);
  const closeFailures = closes
    .filter((r) => r.status === "rejected")
    .map((r) => String((r as PromiseRejectedResult).reason));
  _resetConfigDirForTesting();
  _resetCacheForTesting();
  rmSync(isolatedDir, { recursive: true, force: true });
  // Last, so they don't skip the cleanup above: if the fake daemon itself
  // misbehaved, say so. Otherwise a harness fault presents as "production
  // didn't deliver" and sends the reader to the wrong file.
  assert.deepEqual(harnessFaults, [], "the fake daemon reported no faults");
  assert.deepEqual(closeFailures, [], "every fake daemon closed cleanly");
});

describe("Codex inbound — a routed message reaches the agent's daemon", () => {
  it("delivers a turn/start carrying the attributed text, on the agent's thread", async () => {
    const id = seedCodexAgent("CodexWorker");

    const err = await routeMessage(
      "agent://CodexWorker",
      "ship the integration test",
      senderId,
    );

    assert.equal(err, null, `routing should succeed, got: ${err}`);
    await waitUntil(
      () => daemon.turns.length === 1,
      () => `a turn/start to reach the daemon (saw ${daemon.turns.length})`,
    );
    const turn = daemon.turns[0];
    assert.match(
      turn.text,
      /ship the integration test/,
      "the message body must survive the trip",
    );
    // The exact envelope, not a substring. The sender's NAME appears twice in
    // it, so a name-only check passes even when the reply URI names the wrong
    // agent or is empty — and the recipient is told by BASE_CONTEXT to reply
    // to that URI, so a broken one strands the reply with nobody informed.
    assert.ok(
      turn.text.startsWith(
        `[${SENDER_NAME} → you via agent://${SENDER_NAME}]\n`,
      ),
      `inbound must carry a routable reply address, got: ${turn.text.split("\n")[0]}`,
    );
    assert.equal(
      turn.threadId,
      daemon.threadId,
      "the turn must target the thread the daemon reported, not a guess",
    );

    // Delivered ONCE. `waitUntil` returns the instant it sees 1, so without a
    // second look a double injection is caught only if both turns land inside
    // one poll gap. For Codex a duplicate means the agent executes the same
    // instruction twice, which is worse than a drop.
    const readsAt = daemon.reads;
    await waitUntil(
      () => daemon.reads > readsAt,
      "a further daemon round-trip, to give a duplicate time to appear",
    );
    assert.equal(daemon.turns.length, 1, "exactly one turn — no duplicate");
    assert.equal(
      daemon.connections,
      1,
      "one agent must hold one client connection, not one per message",
    );
    assertNoAlarm();
  });

  it("delivers eventually when the thread reports active on arrival", async () => {
    // The invariant under a busy agent: the message is DELIVERED, not lost.
    // This says nothing about whether it is withheld in the meantime — that is
    // scheduling policy, and asserting it here would pin the very mechanism
    // this test has to survive.
    seedCodexAgent("BusyCodex");
    daemon.status = "active";

    const err = await routeMessage(
      "agent://BusyCodex",
      "you have mail",
      senderId,
    );
    assert.equal(err, null, `routing should succeed, got: ${err}`);

    // Wait for the daemon to have actually SERVED its state to our client (a
    // real protocol event, not a guessed sleep) before flipping it. The
    // turns-length disjunct keeps this from hanging if a future implementation
    // stops reading status on the delivery path.
    await waitUntil(
      () => daemon.reads >= 1 || daemon.turns.length >= 1,
      "the daemon to answer the client at least once",
    );
    daemon.status = "idle";

    await waitUntil(
      () => daemon.turns.length === 1,
      () => `the message to be delivered (saw ${daemon.turns.length})`,
    );
    assert.match(daemon.turns[0].text, /you have mail/);

    const readsAt = daemon.reads;
    await waitUntil(() => daemon.reads > readsAt, "a further round-trip");
    assert.equal(daemon.turns.length, 1, "exactly one turn — no duplicate");
    assertNoAlarm();
  });

  it("delivers only to the addressed agent, not to another agent's daemon", async () => {
    // With a fleet of one, a regression that resolves the endpoint from the
    // wrong agent — or keys the controller registry by endpoint instead of
    // agent id — is invisible: same daemon either way. Cross-agent delivery
    // means one agent reads and acts on another's instructions.
    const other = await startDaemon();
    seedCodexAgent("CodexAlpha");
    seedCodexAgent("CodexBeta", other.endpoint);

    const err = await routeMessage("agent://CodexAlpha", "for alpha", senderId);

    assert.equal(err, null, `routing should succeed, got: ${err}`);
    await waitUntil(
      () => daemon.turns.length === 1,
      () => `the turn to reach Alpha's daemon (saw ${daemon.turns.length})`,
    );
    assert.match(daemon.turns[0].text, /for alpha/);
    assert.equal(
      other.turns.length,
      0,
      "Beta's daemon must not receive a message addressed to Alpha",
    );
  });

  it("broadcasts to every running Codex agent, and to neither the sender nor an exited one", async () => {
    // Broadcast fans out over a different branch than unicast and once skipped
    // Codex agents entirely (#287). Its per-recipient filters are only
    // exercised by a fleet with something to filter OUT.
    const other = await startDaemon();
    const stale = await startDaemon();
    seedCodexAgent("BroadcastAlpha");
    seedCodexAgent("BroadcastBeta", other.endpoint);
    const exitedId = seedCodexAgent("BroadcastGhost", stale.endpoint);
    markExited(exitedId, "user_killed");

    const err = await routeMessage("broadcast://all", "all hands", senderId);

    assert.equal(err, null, `broadcast should succeed, got: ${err}`);
    await waitUntil(
      () => daemon.turns.length === 1 && other.turns.length === 1,
      () =>
        `both live daemons to receive the broadcast (saw ${daemon.turns.length} and ${other.turns.length})`,
    );
    assert.match(daemon.turns[0].text, /all hands/);
    assert.match(other.turns[0].text, /all hands/);
    // An exited agent's endpoint can be a RECYCLED port belonging to a
    // different agent's daemon after a respawn, so this is not merely tidiness.
    assert.equal(
      stale.turns.length,
      0,
      "an exited Codex agent must not be injected into",
    );
  });
});

describe("Codex inbound — transport failures stay visible", () => {
  it("returns an error to the sender when the agent has no live daemon", async () => {
    // A running Codex agent record with no sidecar endpoint: the agent is up
    // but its app-server is not reachable. The sender must be told, because
    // this is the one failure the router can detect synchronously.
    seedAgent(randomUUID(), "EndpointlessCodex", "codex");

    const err = await routeMessage(
      "agent://EndpointlessCodex",
      "hello?",
      senderId,
    );

    assert.ok(err, "must return an error — null would mean success");
    assert.match(err, /not reachable/);
    // The router returns synchronously but delivery is async, so an immediate
    // negative assertion would hold even under a regression that errors the
    // sender AND enqueues to some fallback. Give a delivery time to appear.
    await delay(100);
    assert.equal(
      daemon.turns.length,
      0,
      "nothing may leak to another agent's daemon",
    );
    assert.deepEqual(
      notifications,
      [],
      "the sender already has the error — the operator needs no second alarm",
    );
  });

  it("notifies the operator, naming the agent, when the daemon endpoint is dead", async () => {
    // The endpoint exists but nothing is listening — a daemon that died, or a
    // stale port after a respawn. Delivery is asynchronous by contract, so the
    // sender is ack'd; the operator notification is therefore the ONLY signal
    // that the message did not land. Silence here is the #287 bug.
    const id = seedCodexAgent("DeadDaemonCodex", DEAD_ENDPOINT);

    const err = await routeMessage(
      "agent://DeadDaemonCodex",
      "anybody home?",
      senderId,
    );

    assert.equal(err, null, "delivery is async — the send itself is ack'd");
    // ONE predicate over both fields. Two independent `some()` scans would let
    // the status-feed warning (same agent, different message) satisfy the id
    // half while an unrelated agent's warning satisfies the message half — so
    // a regression that misattributes the alarm would still pass.
    await waitUntil(
      () =>
        notifications.some(
          (n) => n.agentId === id && /aren't being delivered/.test(n.message),
        ),
      () =>
        `a delivery-failure notification naming ${id} (saw ${JSON.stringify(notifications)})`,
    );
    assert.equal(
      daemon.turns.length,
      0,
      "nothing may reach the healthy daemon by accident",
    );
  });

  it("keeps a rejected turn and delivers it once the daemon accepts again", async () => {
    // A daemon that is REACHABLE but refuses the turn — distinct from an
    // unreachable socket, and the failure that most resembles #287: the sender
    // was ack'd, so a message dropped here is dropped in silence.
    //
    // This is also the only condition under which the client's dequeue
    // ORDERING is observable from out here. `codexControl` shifts the queue on
    // the turn/start REPLY; shifting before the await would discard this
    // message on rejection and it would never arrive after the daemon
    // recovers. That ordering has a comment pointing at this test — this is
    // what makes the pointer true rather than a claim of coverage.
    const id = seedCodexAgent("RefusingCodex");
    daemon.rejectTurns = true;

    const err = await routeMessage(
      "agent://RefusingCodex",
      "please take this",
      senderId,
    );
    assert.equal(err, null, "delivery is async — the send itself is ack'd");

    await waitUntil(
      () =>
        notifications.some(
          (n) => n.agentId === id && /aren't being delivered/.test(n.message),
        ),
      () =>
        `an operator notification about the refused turn (saw ${JSON.stringify(notifications)})`,
    );
    assert.equal(daemon.turns.length, 0, "a rejected turn is not a delivery");

    daemon.rejectTurns = false;
    await waitUntil(
      () => daemon.turns.length === 1,
      () =>
        `the retained message to be delivered once accepted (saw ${daemon.turns.length}, attempts ${daemon.turnAttempts})`,
    );
    assert.match(daemon.turns[0].text, /please take this/);
  });

  it("notifies the operator when the agent's thread never appears", async () => {
    // The daemon is up but reports no threads — a `--remote` TUI that never
    // attached, so there is no conversation to inject into. Without a signal
    // this agent swallows every inbound message forever while looking healthy.
    const id = seedCodexAgent("ThreadlessCodex");
    daemon.reportNoThreads = true;

    const err = await routeMessage(
      "agent://ThreadlessCodex",
      "are you there?",
      senderId,
    );
    assert.equal(err, null, "delivery is async — the send itself is ack'd");

    await waitUntil(
      () =>
        notifications.some(
          (n) => n.agentId === id && /aren't being delivered/.test(n.message),
        ),
      () =>
        `an operator notification about the missing thread (saw ${JSON.stringify(notifications)})`,
      8_000,
    );
    assert.equal(daemon.turns.length, 0, "there is no thread to inject into");
  });
});
