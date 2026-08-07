import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RateLimitData } from "../plugins/claude-usage/scanner.js";
import type { CodexUsageData } from "../plugins/codex-usage/types.js";
import {
  createUsageQueue,
  evaluateCap,
  type NormalizedUsage,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  type UsageQueue,
} from "../usageQueue.js";

/**
 * Unit tests for the usage-queue edge detector — the timing-sensitive core.
 *
 * Determinism: we inject a mutable `usage` snapshot and drive `tick()` by hand
 * with a huge poll interval (the internal timer never fires), so each test is a
 * precise sequence of "set the usage state, run one poll, assert." No real
 * clocks, no network, no PTY.
 */

const EMPTY: RateLimitData = {
  fiveHour: null,
  sevenDay: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  extraUsage: null,
  account: {},
  fetchedAt: "2026-06-20T00:00:00.000Z",
};

/** A snapshot with a given 5-hour utilization% and reset hint. */
function usageAt(
  utilization: number,
  resetsAt = "2026-06-20T05:00:00Z",
): RateLimitData {
  return { ...EMPTY, fiveHour: { utilization, resetsAt } };
}

interface Harness {
  queue: UsageQueue;
  setUsage: (data: RateLimitData) => void;
  sent: string[];
  /** Captured notify() calls (silent-failure surfacing). */
  notes: Array<{ sessionId: string; message: string }>;
  /** Make the PTY appear gone for the given session (sendSubmit returns false). */
  killPty: (sessionId: string) => void;
}

function makeHarness(): Harness {
  let usage = EMPTY;
  const sent: string[] = [];
  const notes: Array<{ sessionId: string; message: string }> = [];
  const dead = new Set<string>();
  const queue = createUsageQueue({
    // The fixtures build Claude RateLimitData; the probe runs the REAL adapter
    // so these tests also cover normalizeClaudeUsage. Panes arm as "claude-code".
    probes: {
      "claude-code": () => Promise.resolve(normalizeClaudeUsage(usage)),
    },
    sendSubmit: (sessionId) => {
      if (dead.has(sessionId)) return false;
      sent.push(sessionId);
      return true;
    },
    notify: (sessionId, message) => notes.push({ sessionId, message }),
    // Drive tick() by hand — don't race arm's fire-and-forget evaluation.
    evaluateOnArm: false,
    intervalMs: 1_000_000_000, // internal timer effectively never fires
  });
  return {
    queue,
    setUsage: (data) => {
      usage = data;
    },
    sent,
    notes,
    killPty: (sessionId) => dead.add(sessionId),
  };
}

/** Usage snapshot that mimics the scanner's error result: no windows, an
 * errorKind set. Used to exercise the permanent-vs-transient branch. */
function errorUsage(errorKind: RateLimitData["errorKind"]): RateLimitData {
  return { ...EMPTY, error: "boom", errorKind };
}

describe("usageQueue edge detector", () => {
  let h: Harness | null = null;
  afterEach(() => h?.queue.stop());

  it("arming while capped fires Enter once the limit clears", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100)); // currently capped
    h.queue.arm("pane-a", "claude-code");
    await h.queue.tick(); // still capped → no fire
    assert.deepEqual(h.sent, []);
    assert.equal(h.queue.status().caps["claude-code"]?.capped ?? false, true);

    h.setUsage(usageAt(2)); // limit cleared
    await h.queue.tick();
    assert.deepEqual(h.sent, ["pane-a"]);
    assert.equal(h.queue.isArmed("pane-a"), false, "fires once then disarms");
  });

  it("arming before capped waits, then fires on the next block→clear", async () => {
    h = makeHarness();
    h.setUsage(usageAt(30)); // not blocked yet
    h.queue.arm("pane-b", "claude-code");
    await h.queue.tick();
    assert.deepEqual(h.sent, [], "no block seen yet → must not fire");

    h.setUsage(usageAt(100)); // now hits the wall
    await h.queue.tick();
    assert.deepEqual(h.sent, []);

    h.setUsage(usageAt(1)); // clears
    await h.queue.tick();
    assert.deepEqual(h.sent, ["pane-b"]);
  });

  it("a pane that was never blocked never auto-fires", async () => {
    h = makeHarness();
    h.setUsage(usageAt(40));
    h.queue.arm("pane-c", "claude-code");
    for (let i = 0; i < 5; i++) await h.queue.tick();
    assert.deepEqual(
      h.sent,
      [],
      "low utilization throughout → no spurious send",
    );
  });

  it("hysteresis: a dip between exit and enter thresholds does not fire", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("pane-d", "claude-code");
    await h.queue.tick(); // blocked
    h.setUsage(usageAt(85)); // 80 ≤ 85 < 90 → still blocked (no flap)
    await h.queue.tick();
    assert.deepEqual(
      h.sent,
      [],
      "still considered blocked in the hysteresis band",
    );
    assert.equal(h.queue.status().caps["claude-code"]?.capped ?? false, true);

    h.setUsage(usageAt(70)); // below exit → cleared
    await h.queue.tick();
    assert.deepEqual(h.sent, ["pane-d"]);
  });

  it("fires all armed panes at once on a shared clear", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("p1", "claude-code");
    h.queue.arm("p2", "claude-code");
    h.queue.arm("p3", "claude-code");
    await h.queue.tick();
    h.setUsage(usageAt(0));
    await h.queue.tick();
    assert.deepEqual(h.sent.sort(), ["p1", "p2", "p3"]);
  });

  it("a gone PTY is dropped without throwing, and disarmed", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("ghost", "claude-code");
    await h.queue.tick();
    h.killPty("ghost");
    h.setUsage(usageAt(0));
    await h.queue.tick();
    assert.deepEqual(h.sent, [], "no submit recorded for a dead PTY");
    assert.equal(h.queue.isArmed("ghost"), false, "still disarmed (one-shot)");
    assert.equal(
      h.notes.length,
      1,
      "the silent drop is surfaced, not swallowed",
    );
    assert.equal(h.notes[0].sessionId, "ghost");
  });

  it("disarm cancels a pending auto-send", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("pane-e", "claude-code");
    await h.queue.tick();
    h.queue.disarm("pane-e");
    h.setUsage(usageAt(0));
    await h.queue.tick();
    assert.deepEqual(h.sent, []);
  });

  it("holds state when usage is unreadable (no creds / error)", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("pane-f", "claude-code");
    await h.queue.tick();
    h.setUsage(EMPTY); // all windows null → no signal
    await h.queue.tick();
    assert.deepEqual(h.sent, [], "must not treat 'no data' as a clear");
    assert.equal(
      h.queue.status().caps["claude-code"]?.capped ?? false,
      true,
      "blocked state held across the gap",
    );
  });

  it("status exposes the nearest blocking reset as an ETA hint", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100, "2026-06-20T05:00:00Z"));
    h.queue.arm("pane-g", "claude-code");
    await h.queue.tick();
    assert.equal(
      h.queue.status().caps["claude-code"]?.resetsAt ?? null,
      "2026-06-20T05:00:00Z",
    );
  });

  it("warns each armed pane once on a permanent credential failure", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("p1", "claude-code");
    h.queue.arm("p2", "claude-code");
    await h.queue.tick(); // blocked

    h.setUsage(errorUsage("unauthorized")); // creds expired → queue can't fire
    await h.queue.tick();
    await h.queue.tick(); // still failing — must NOT re-warn every tick
    assert.equal(h.notes.length, 2, "one warning per armed pane, once");
    assert.deepEqual(h.notes.map((n) => n.sessionId).sort(), ["p1", "p2"]);
    assert.deepEqual(h.sent, [], "never fires while creds are broken");

    // Signal returns then clears — the one-shot warning re-arms and it fires.
    h.setUsage(usageAt(0));
    await h.queue.tick();
    assert.deepEqual(h.sent.sort(), ["p1", "p2"]);
  });

  it("warns a pane armed AFTER creds break, while they stay broken", async () => {
    // Regression: the auth-warning latch is per-pane, not a single global flag.
    // A pane armed after an earlier pane was already warned must still be told
    // its queued send can never fire — otherwise it fails silently.
    h = makeHarness();
    h.setUsage(errorUsage("unauthorized"));
    h.queue.arm("early", "claude-code");
    await h.queue.tick(); // warns "early"
    assert.deepEqual(
      h.notes.map((n) => n.sessionId),
      ["early"],
    );

    h.queue.arm("late", "claude-code"); // armed while creds are STILL broken
    await h.queue.tick();
    assert.equal(
      h.notes.filter((n) => n.sessionId === "late").length,
      1,
      "a pane armed after the first warning must still be warned",
    );
    assert.equal(
      h.notes.filter((n) => n.sessionId === "early").length,
      1,
      "the already-warned pane is not re-warned",
    );
  });

  it("does not warn on a transient usage failure", async () => {
    h = makeHarness();
    h.setUsage(usageAt(100));
    h.queue.arm("pane-h", "claude-code");
    await h.queue.tick();
    h.setUsage(errorUsage("rate_limited")); // transient — hold quietly
    await h.queue.tick();
    assert.deepEqual(h.notes, [], "transient failures are not user-facing");
    assert.equal(
      h.queue.status().caps["claude-code"]?.capped ?? false,
      true,
      "blocked state held",
    );
  });

  it("does not double-fire when two ticks overlap (re-entrancy guard)", async () => {
    // Gate getUsage so the first tick suspends mid-flight while a second tick
    // is issued — the exact concurrency that could fire two Enters.
    let usage = usageAt(100);
    let gate: Promise<void> | null = null;
    const sent: string[] = [];
    const queue = createUsageQueue({
      probes: {
        "claude-code": async () => {
          if (gate) await gate;
          return normalizeClaudeUsage(usage);
        },
      },
      sendSubmit: (id) => {
        sent.push(id);
        return true;
      },
      evaluateOnArm: false,
      intervalMs: 1_000_000_000,
    });
    queue.arm("pane", "claude-code");
    await queue.tick(); // observe blocked (gate open) → seenBlocked latches
    assert.equal(queue.status().caps["claude-code"]?.capped ?? false, true);

    usage = usageAt(0); // limit cleared
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    const t1 = queue.tick(); // enters, suspends at the gated getUsage
    const t2 = queue.tick(); // re-entrant → must no-op
    release();
    await Promise.all([t1, t2]);

    assert.deepEqual(sent, ["pane"], "exactly one Enter despite overlap");
    queue.stop();
  });
});

// ── Per-runtime isolation (ADR-068) ────────────────────────────

/** A queue with independent Claude + Codex usage controls. */
function makeMultiHarness() {
  let claude: RateLimitData = EMPTY;
  let codex: NormalizedUsage = { windows: [] };
  const sent: string[] = [];
  const queue = createUsageQueue({
    probes: {
      "claude-code": () => Promise.resolve(normalizeClaudeUsage(claude)),
      codex: () => Promise.resolve(codex),
    },
    sendSubmit: (id) => {
      sent.push(id);
      return true;
    },
    evaluateOnArm: false,
    intervalMs: 1_000_000_000,
  });
  return {
    queue,
    sent,
    setClaude: (u: RateLimitData) => {
      claude = u;
    },
    setCodex: (utilization: number) => {
      codex = { windows: [{ utilization, resetsAt: null }] };
    },
  };
}

describe("usageQueue per-runtime isolation", () => {
  it("a CLAUDE cap does not block or fire a Codex pane (the reported bug)", async () => {
    const h = makeMultiHarness();
    h.setClaude(usageAt(100)); // Claude account maxed…
    h.setCodex(30); // …but Codex is fine
    h.queue.arm("codex-pane", "codex");
    await h.queue.tick();
    await h.queue.tick();
    assert.deepEqual(h.sent, [], "a Codex pane must ignore the Claude limit");
    assert.notEqual(
      h.queue.status().caps.codex?.capped,
      true,
      "the Codex pane's own runtime is not capped",
    );
    h.queue.stop();
  });

  it("a Codex pane fires on the CODEX clear edge", async () => {
    const h = makeMultiHarness();
    h.setCodex(100);
    h.queue.arm("codex-pane", "codex");
    await h.queue.tick(); // codex blocked
    assert.deepEqual(h.sent, []);
    h.setCodex(0); // codex clears
    await h.queue.tick();
    assert.deepEqual(h.sent, ["codex-pane"]);
    h.queue.stop();
  });

  it("Claude and Codex panes fire independently, each on its own limit", async () => {
    const h = makeMultiHarness();
    h.setClaude(usageAt(100));
    h.setCodex(100);
    h.queue.arm("cc", "claude-code");
    h.queue.arm("cx", "codex");
    await h.queue.tick(); // both blocked

    h.setClaude(usageAt(0)); // only Claude clears
    await h.queue.tick();
    assert.deepEqual(h.sent, ["cc"], "only the Claude pane fires");

    h.setCodex(0); // now Codex clears
    await h.queue.tick();
    assert.deepEqual(h.sent, ["cc", "cx"], "then the Codex pane fires");
    h.queue.stop();
  });

  it("arming a runtime with no usage source (gemini) is a no-op", async () => {
    const h = makeMultiHarness();
    h.queue.arm("g", "gemini-cli");
    assert.equal(h.queue.isArmed("g"), false, "no probe → nothing to wait on");
    h.queue.stop();
  });
});

describe("usage adapters + evaluateCap", () => {
  it("normalizeCodexUsage maps usedPercent→utilization across all windows", () => {
    const data = {
      primary: { usedPercent: 92, windowMinutes: 10080, resetsAt: "R1" },
      secondary: { usedPercent: 40, windowMinutes: 300, resetsAt: "R2" },
      additionalLimits: [
        {
          name: "Spark",
          primary: { usedPercent: 5, windowMinutes: 300, resetsAt: "R3" },
          secondary: null,
        },
      ],
      credits: null,
      planType: null,
      account: {},
      source: "live",
      fetchedAt: "now",
    } as unknown as CodexUsageData;
    const n = normalizeCodexUsage(data);
    assert.deepEqual(
      n.windows.map((w) => w.utilization).sort((a, b) => a - b),
      [5, 40, 92],
    );
    assert.equal(evaluateCap(n).capped, true, "92% ≥ 90 → capped");
  });

  it("normalizeCodexUsage IGNORES a stale rollout snapshot (no live signal → no cap)", () => {
    // A frozen on-disk rollout at 100% must not read as a live cap — else an
    // armed Codex pane latches capped forever with no clear edge (Nox).
    const data = {
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: "R" },
      secondary: null,
      additionalLimits: [],
      credits: null,
      planType: null,
      account: {},
      source: "rollout",
      fetchedAt: "now",
    } as unknown as CodexUsageData;
    const n = normalizeCodexUsage(data);
    assert.deepEqual(n.windows, [], "a non-live snapshot yields no windows");
    assert.equal(
      evaluateCap(n).capped,
      false,
      "so it is never treated as capped",
    );
  });

  it("normalizeCodexUsage flags a credential failure as authError", () => {
    const data = {
      primary: null,
      secondary: null,
      additionalLimits: [],
      credits: null,
      planType: null,
      account: {},
      source: "rollout",
      fetchedAt: "now",
      errorKind: "unauthorized",
    } as unknown as CodexUsageData;
    const n = normalizeCodexUsage(data);
    assert.deepEqual(n.windows, []);
    assert.equal(n.authError, true);
  });

  it("evaluateCap: below the cap is not capped", () => {
    assert.equal(
      evaluateCap({ windows: [{ utilization: 89, resetsAt: null }] }).capped,
      false,
    );
  });
});
