/**
 * Periodic scans must not freeze the server on large session dirs.
 *
 * Symptom (a Linux server with large session dirs): every ~60s the whole
 * server froze ~10s, every dashboard socket dropped, and RSS jumped ~2GB. The
 * fallback that runs when the live usage endpoint fails read the 8 newest
 * rollout files WHOLE (readFileSync + split) on the event loop; single
 * rollouts there are 400-540MB.
 *
 * Fixture: three ~150MB generated rollouts whose newest token_count sits at
 * the tail (as Codex appends it), and a ~150MB Claude Code session whose
 * custom title sits in the middle (outside any head/tail window). The guard
 * runs the REAL fallback, the REAL usage poll (live endpoint failing) and the
 * REAL Projects route, and bounds the worst event-loop stall and the peak RSS
 * growth while they run.
 *
 * Box load must not trip it (10-29: p99 134-138ms at load 22.7 blocked a
 * push). Load delays every timer tick, so the stall and p99 bounds apply to
 * what the scan ADDS over an idle window measured just before it, in the same
 * run. Peak RSS doesn't depend on load at all, and the whole-file reader blows
 * through it (+860-1200MB against 200MB), so a restored readFileSync goes RED
 * whatever the load.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";

// Every path a scanner can read is under TEST_DIR (it doubles as HOME), so
// nothing here can touch a real history.
const TEST_DIR = join(tmpdir(), `aos-big-scan-${process.pid}-${Date.now()}`);
const CODEX = join(TEST_DIR, ".codex");
process.env.HOME = TEST_DIR;
process.env.CODEX_HOME = CODEX;
process.env.CLAUDE_CONFIG_DIR = join(TEST_DIR, ".claude");
process.env.GEMINI_CLI_HOME = TEST_DIR;
process.env.AUTONOMOS_CONFIG_DIR = join(TEST_DIR, "aos-config");

const { readFreshestRollout } = await import(
  "../plugins/codex-usage/rolloutScanner.js"
);
const { getCodexUsage, invalidateCodexUsageCache } = await import(
  "../plugins/codex-usage/scanner.js"
);
const { projectRouter, _resetForTesting } = await import(
  "../routes/projects.js"
);
const { cwdToDirName } = await import("../titleCache.js");

const FILE_MB = Number(process.env.BIG_ROLLOUT_MB ?? 150);
const FILES = 3;
// Bounds. The fixed Codex reader touches ≤ a few MB per file, off the event
// loop (measured 12-28ms worst under 4× parallel load; the whole-file reader
// measured 150-610ms and +860-1200MB on the same fixture). The Projects cold
// scan also runs the route's own listing/grouping work, which measured up to
// ~100ms worst (p99 ≤ 42ms) under that load, so it's bounded by p99 plus a
// looser worst-case. RSS is the sharpest signal: a whole-file read of these
// fixtures needs hundreds of MB.
// Stall/p99 bounds are on top of the idle baseline (see `responsive`).
const MAX_STALL_MS = 100;
const PROJECTS_MAX_STALL_MS = 250;
const P99_MS = 100;
const MAX_RSS_GROWTH_MB = 200;

function tokenCount(ts: string, used: number): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          used_percent: used,
          window_minutes: 300,
          resets_at: 1_900_000_000,
        },
        secondary: null,
        plan_type: "pro",
      },
    },
  });
}

/** ~1MB of whole copies of `line`. */
function slabOf(line: string): string {
  return line.repeat(Math.floor((1024 * 1024) / line.length));
}

/** A ~FILE_MB rollout: an old token_count first, MBs of turn noise, and the
 *  freshest token_count at the very end. Written in 1MB slabs (fast). */
function writeBigRollout(path: string, freshTs: string, used: number): void {
  const noiseLine = `${JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "x".repeat(2000) }],
    },
  })}\n`;
  const slab = slabOf(noiseLine);
  const fd = openSync(path, "w");
  try {
    writeSync(fd, `${tokenCount("2026-01-01T00:00:00.000Z", 1)}\n`);
    for (let i = 0; i < FILE_MB; i++) writeSync(fd, slab);
    writeSync(fd, `${tokenCount(freshTs, used)}\n`);
  } finally {
    closeSync(fd);
  }
}

/** A fake ChatGPT-plan auth.json whose access token expires in an hour. */
function writeAuth(): void {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  writeFileSync(
    join(CODEX, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: jwt,
        refresh_token: "r",
        id_token: jwt,
        account_id: "acct",
      },
    }),
  );
}

/** Run `fn` while measuring the worst stall, p99 delay and peak RSS growth. */
async function measured(fn: () => Promise<unknown>): Promise<Measured> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now();
  let worst = 0;
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  h.enable();
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 50)); // let the last stall register
  } finally {
    h.disable();
    clearInterval(tick);
  }
  return {
    worstMs: Math.max(worst, h.max / 1e6),
    p99Ms: h.percentile(99) / 1e6,
    rssGrowthMb: (peak - rss0) / 1024 / 1024,
  };
}

interface Measured {
  worstMs: number;
  p99Ms: number;
  rssGrowthMb: number;
}

/** The same probe over an idle window: what box load alone does to it now.
 *  1s, so one momentary spike isn't the whole sample. */
const idleBaseline = () =>
  measured(() => new Promise((r) => setTimeout(r, 1000)));
/** Load allowance cap: a spike during the baseline can't erase the stall
 *  bound (a blocking read that leaves RSS flat, e.g. a sync chunked read,
 *  must still fail on a loaded box). Far below the field's ~10s stall. */
const MAX_IDLE_ALLOWANCE_MS = 500;

/** Asserts the scan stayed responsive: stall and p99 over the idle baseline,
 *  peak RSS growth absolute. Logs both so a failure shows the load. */
function assertResponsive(
  label: string,
  m: Measured,
  idle: Measured,
  bounds: { stallMs: number; p99Ms: number },
): void {
  process.stderr.write(
    `MEASURED ${label}: worst stall ${m.worstMs.toFixed(0)}ms, p99 ${m.p99Ms.toFixed(0)}ms, peak RSS +${m.rssGrowthMb.toFixed(0)}MB (idle baseline: worst ${idle.worstMs.toFixed(0)}ms, p99 ${idle.p99Ms.toFixed(0)}ms)\n`,
  );
  const stallBound =
    bounds.stallMs + Math.min(idle.worstMs, MAX_IDLE_ALLOWANCE_MS);
  const p99Bound = bounds.p99Ms + Math.min(idle.p99Ms, MAX_IDLE_ALLOWANCE_MS);
  assert.ok(
    m.worstMs < stallBound,
    `${label} froze the event loop for ${m.worstMs.toFixed(0)}ms (bound ${bounds.stallMs}ms + idle ${idle.worstMs.toFixed(0)}ms)`,
  );
  assert.ok(
    m.p99Ms < p99Bound,
    `${label}: event-loop p99 ${m.p99Ms.toFixed(0)}ms (bound ${bounds.p99Ms}ms + idle ${idle.p99Ms.toFixed(0)}ms)`,
  );
  assert.ok(
    m.rssGrowthMb < MAX_RSS_GROWTH_MB,
    `${label}: RSS grew ${m.rssGrowthMb.toFixed(0)}MB (bound ${MAX_RSS_GROWTH_MB}MB)`,
  );
}

describe("Codex usage fallback on large rollouts", () => {
  before(() => {
    const day = join(CODEX, "sessions", "2026", "10", "24");
    mkdirSync(day, { recursive: true });
    writeAuth();
    for (let i = 0; i < FILES; i++)
      writeBigRollout(
        join(day, `rollout-big-${i}.jsonl`),
        `2026-10-24T0${i}:00:00.000Z`,
        10 + i,
      );
  });
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it(`finds the freshest snapshot without stalling the event loop (${FILES} × ${FILE_MB}MB)`, async () => {
    const out: { snap?: Awaited<ReturnType<typeof readFreshestRollout>> } = {};
    const idle = await idleBaseline();
    const m = await measured(async () => {
      out.snap = await readFreshestRollout();
    });
    const snap = out.snap;
    assert.ok(snap, "found a snapshot");
    // precondition: it really read each file's TAIL (the freshest event)
    assert.equal(snap?.snapshotAt, `2026-10-24T0${FILES - 1}:00:00.000Z`);
    assertResponsive("fallback scan", m, idle, {
      stallMs: MAX_STALL_MS,
      p99Ms: P99_MS,
    });
  });

  it("the real usage poll with the live endpoint failing stays responsive", async () => {
    invalidateCodexUsageCache();
    const failing = async () => new Response("down", { status: 503 });
    const out: { data?: Awaited<ReturnType<typeof getCodexUsage>> } = {};
    const idle = await idleBaseline();
    const m = await measured(async () => {
      out.data = await getCodexUsage(failing as never);
    });
    assert.equal(out.data?.source, "rollout", "served the on-disk fallback");
    assertResponsive("usage poll (live failing)", m, idle, {
      stallMs: MAX_STALL_MS,
      p99Ms: P99_MS,
    });
  });
});

describe("Projects scan on a large Claude Code session", () => {
  const SID = "bbbbbbbb-0000-4000-8000-000000000001";
  const CWD = join(TEST_DIR, "work");
  let file: string;
  const turn = `${JSON.stringify({
    type: "assistant",
    sessionId: SID,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "y".repeat(2000) }],
    },
  })}\n`;

  before(() => {
    mkdirSync(CWD, { recursive: true });
    const dir = join(TEST_DIR, ".claude", "projects", cwdToDirName(CWD));
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${SID}.jsonl`);
    const slab = slabOf(turn);
    const fd = openSync(file, "w");
    try {
      writeSync(
        fd,
        `${JSON.stringify({ type: "user", sessionId: SID, cwd: CWD, uuid: "u1", timestamp: "2026-10-24T00:00:00.000Z", message: { role: "user", content: "start the big job" } })}\n`,
      );
      for (let i = 0; i < FILE_MB / 2; i++) writeSync(fd, slab);
      writeSync(
        fd,
        `${JSON.stringify({ type: "custom-title", customTitle: "Big middle title", sessionId: SID })}\n`,
      );
      for (let i = 0; i < FILE_MB / 2; i++) writeSync(fd, slab);
    } finally {
      closeSync(fd);
    }
    _resetForTesting();
  });

  async function scanProjects() {
    _resetForTesting(); // no shared-result reuse: every call is a real scan
    const res = await projectRouter.request("/");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{
      sessions: Array<{ sessionId: string; summary: string }>;
    }>;
    return body.flatMap((p) => p.sessions).find((s) => s.sessionId === SID);
  }

  it(`a cold scan resolves a mid-file title without stalling (${FILE_MB}MB session)`, async () => {
    const out: { row?: Awaited<ReturnType<typeof scanProjects>> } = {};
    const idle = await idleBaseline();
    const m = await measured(async () => {
      out.row = await scanProjects();
    });
    // precondition: the big file really was scanned past its head and tail
    assert.equal(out.row?.summary, "Big middle title");
    // A short scan has few samples, so its p99 is ~its worst gap: one bound.
    assertResponsive("Projects cold scan", m, idle, {
      stallMs: PROJECTS_MAX_STALL_MS,
      p99Ms: PROJECTS_MAX_STALL_MS,
    });
  });

  it("after a new turn is appended, the rescan reads only the new turn", async () => {
    appendFileSync(file, turn);
    const t0 = performance.now();
    const row = await scanProjects();
    const ms = performance.now() - t0;
    process.stderr.write(
      `MEASURED Projects warm rescan after append: ${ms.toFixed(0)}ms\n`,
    );
    assert.equal(row?.summary, "Big middle title");
  });
});
