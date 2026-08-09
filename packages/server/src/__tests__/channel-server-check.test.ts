/**
 * Channel-server registration check — escalating probes + retraction.
 *
 * The one-shot 30s predecessor mass-produced false "can't send messages"
 * warnings for the whole fleet on every restart-all (2026-08-08 audit: 23/33
 * live panel notifications). These tests pin the replacement in BOTH
 * directions: slow-but-healthy registration must NOT warn (or must retract if
 * it already did), and a channel server that never registers MUST still warn.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  _resetChannelServerChecksForTesting,
  CHANNEL_SERVER_PROBE_DELAYS_MS,
  type ChannelServerCheckIO,
  cancelChannelServerCheck,
  noteChannelServerRegistered,
  trackChannelServerRegistration,
} from "../agents/channelServerCheck.js";

const DELAYS = [1000, 2000, 3000] as const; // fast stand-ins for 30s/60s/90s
const ALL_DELAYS = DELAYS[0] + DELAYS[1] + DELAYS[2];

/** node:test's mock.timers does NOT run timers scheduled DURING a tick (unlike
 *  vitest), so a chained probe needs one tick per hop. */
function tickThroughAllProbes(): void {
  for (const d of DELAYS) mock.timers.tick(d);
}

interface Harness {
  io: ChannelServerCheckIO;
  registered: boolean;
  live: boolean;
  notified: string[];
  retracted: string[];
}

function makeHarness(): Harness {
  const h: Harness = {
    registered: false,
    live: true,
    notified: [],
    retracted: [],
    io: undefined as unknown as ChannelServerCheckIO,
  };
  let nextId = 0;
  h.io = {
    probe: () => h.registered,
    isLive: () => h.live,
    notify: (message) => {
      h.notified.push(message);
      return `n-${++nextId}`;
    },
    retract: (id) => {
      h.retracted.push(id);
      return true;
    },
    probeDelaysMs: [...DELAYS],
  };
  return h;
}

describe("trackChannelServerRegistration", () => {
  let warnings: string[];
  let logs: string[];

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    warnings = [];
    logs = [];
    mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    mock.method(console, "log", (...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  afterEach(() => {
    _resetChannelServerChecksForTesting();
    mock.timers.reset();
    mock.restoreAll();
  });

  it("stays silent when the agent registers before the first probe", () => {
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    h.registered = true;
    mock.timers.tick(ALL_DELAYS + 1000);
    assert.deepEqual(h.notified, []);
    assert.deepEqual(warnings, []);
  });

  it("does NOT warn at the first probe miss — it re-probes (the one-shot false-alarm regression)", () => {
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);

    // t = just past the old one-shot grace: unregistered, but NO warning yet.
    mock.timers.tick(DELAYS[0] + 1);
    assert.deepEqual(h.notified, []);
    assert.deepEqual(warnings, []);

    // Registration lands between probes → the whole check stands down quietly.
    h.registered = true;
    mock.timers.tick(DELAYS[1] + DELAYS[2]);
    assert.deepEqual(h.notified, []);
    assert.deepEqual(warnings, []);
  });

  it("still warns (once, on the final miss) when the channel server never registers", () => {
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    tickThroughAllProbes();
    assert.equal(h.notified.length, 1);
    assert.ok(h.notified[0].includes("can't send messages"));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("never registered"));
    // No further warnings after the final miss.
    mock.timers.tick(60_000);
    assert.equal(h.notified.length, 1);
    assert.equal(warnings.length, 1);
  });

  it("retracts the warning when registration arrives after the final miss", () => {
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    tickThroughAllProbes();
    assert.equal(h.notified.length, 1);

    noteChannelServerRegistered("agent-1");
    assert.deepEqual(h.retracted, ["n-1"]);
    assert.ok(
      logs.some((l) => l.includes("warning retracted")),
      "must log the correction",
    );
  });

  it("stands down silently when the spawn is no longer the live attachment", () => {
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    h.live = false; // killed/respawned within the grace window
    mock.timers.tick(ALL_DELAYS + 1000);
    assert.deepEqual(h.notified, []);
    // A registration edge for the abandoned check is a no-op.
    noteChannelServerRegistered("agent-1");
    assert.deepEqual(h.retracted, []);
  });

  it("treats an unknown probe (gateway not wired) as don't-warn", () => {
    const h = makeHarness();
    h.io.probe = () => null;
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    mock.timers.tick(ALL_DELAYS + 1000);
    assert.deepEqual(h.notified, []);
  });

  it("cancel disposes pending probes; re-tracking replaces a prior check", () => {
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    cancelChannelServerCheck("agent-1");
    mock.timers.tick(ALL_DELAYS + 1000);
    assert.deepEqual(h.notified, []);

    // Re-track after cancel works from a clean slate.
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    tickThroughAllProbes();
    assert.equal(h.notified.length, 1);
  });

  it("noteChannelServerRegistered is a no-op for untracked agents", () => {
    assert.doesNotThrow(() => noteChannelServerRegistered("nobody"));
  });

  it("RESPAWN CARRY — a warning survives cancel (kill) + re-track and is retracted by the new spawn's registration", () => {
    // The exact gap found in review: every real respawn path cancels before
    // re-tracking, so warning memory dropped at cancel made the carry dead
    // code — the operator's respawn (the likeliest response to the warning)
    // left the stale warning up forever.
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    tickThroughAllProbes();
    assert.equal(h.notified.length, 1, "first spawn warned");

    cancelChannelServerCheck("agent-1"); // kill path
    const h2 = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h2.io); // respawn
    h2.registered = true;
    mock.timers.tick(DELAYS[0]); // first probe sees it registered
    assert.deepEqual(
      h2.retracted,
      ["n-1"],
      "the replacement spawn's success retracts the carried warning",
    );
  });

  it("a stale fired-but-queued probe cannot evict a replacement's fresh check", () => {
    // Timer-identity guard: probes for spawn 1 that run after spawn 2 replaced
    // it must not delete spawn 2's map entry (that would orphan it from the
    // registration edge and cancel).
    const h = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h.io);
    h.live = false; // spawn 1 was killed…
    const h2 = makeHarness();
    trackChannelServerRegistration("agent-1", "A@x", h2.io); // …and replaced
    // Advance past both first probes: spawn 1's callback (isLive false) must
    // stand down WITHOUT touching spawn 2's entry, whose probes continue.
    tickThroughAllProbes();
    assert.equal(h2.notified.length, 1, "replacement check still completes");
    noteChannelServerRegistered("agent-1");
    assert.deepEqual(h2.retracted, ["n-1"], "replacement is still addressable");
  });

  it("default schedule keeps multiple probes over at least two minutes", () => {
    // Guard the shape, not the exact numbers: multiple probes, ending well past
    // the old 30s one-shot.
    assert.ok(CHANNEL_SERVER_PROBE_DELAYS_MS.length > 1);
    const total = CHANNEL_SERVER_PROBE_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(total >= 120_000);
  });
});
