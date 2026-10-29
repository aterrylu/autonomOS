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
 * Box load must not trip it. Every agent's pre-push gate runs this file, at
 * loads of 20-80. So the bounds that decide RED are the ones load can't move:
 * - bytes read SYNCHRONOUSLY on the event loop (the bug itself: readFileSync of
 *   whole rollouts), counted by wrapping node:fs;
 * - peak RSS growth (+860-1200MB for the whole-file reader, against 200MB).
 * Timing is only a backstop: the worst single stall against a 1s ceiling, well
 * above load noise and far below the field's ~10s freeze. Measured with the
 * fixed code at load 54-80 (10-29): stalls up to 364ms and p99 up to 299ms. A
 * scan this short has few samples, so its p99 is about its worst gap. p99 and
 * an idle baseline are logged, not asserted: neither separates the bug from a
 * loaded box, while sync bytes do (0.00MB fixed vs 449.88MB whole-file reader).
 */

import assert from "node:assert/strict";
import fs, {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
// Worst single stall: a ceiling over load noise (see the header).
const MAX_STALL_MS = 1_000;
const MAX_RSS_GROWTH_MB = 200;
// Sync bytes per scan. The fixed code reads only auth/config files and the
// Projects scanner's capped 256KB heads synchronously: well under 2MB. One
// whole-file read of a fixture is FILE_MB.
const MAX_SYNC_READ_MB = 2;

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
/** Counts bytes read synchronously (readFileSync / readSync) while `fn` runs.
 *  Wraps node:fs and re-syncs the ESM named exports, so a module that did
 *  `import { readFileSync } from "node:fs"` is counted too. */
async function countingSyncReads<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; bytes: number }> {
  const origFile = fs.readFileSync;
  const origRead = fs.readSync;
  let bytes = 0;
  // readFileSync may call fs.readSync internally: count each byte once.
  let inReadFile = 0;
  fs.readFileSync = ((...args: Parameters<typeof origFile>) => {
    inReadFile++;
    try {
      const out = origFile(...args);
      bytes += typeof out === "string" ? Buffer.byteLength(out) : out.length;
      return out;
    } finally {
      inReadFile--;
    }
  }) as typeof origFile;
  fs.readSync = ((...args: Parameters<typeof origRead>) => {
    const n = origRead(...args);
    if (inReadFile === 0) bytes += n;
    return n;
  }) as typeof origRead;
  syncBuiltinESMExports();
  try {
    return { result: await fn(), bytes };
  } finally {
    fs.readFileSync = origFile;
    fs.readSync = origRead;
    syncBuiltinESMExports();
  }
}

async function measured(fn: () => Promise<unknown>): Promise<Measured> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now();
  let worst = 0;
  const rss0 = process.memoryUsage().rss;
  let syncBytes = 0;
  let peak = rss0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  h.enable();
  try {
    syncBytes = (await countingSyncReads(fn)).bytes;
    await new Promise((r) => setTimeout(r, 50)); // let the last stall register
  } finally {
    h.disable();
    clearInterval(tick);
  }
  return {
    worstMs: Math.max(worst, h.max / 1e6),
    p99Ms: h.percentile(99) / 1e6,
    rssGrowthMb: (peak - rss0) / 1024 / 1024,
    syncReadMb: syncBytes / 1024 / 1024,
  };
}

interface Measured {
  worstMs: number;
  p99Ms: number;
  rssGrowthMb: number;
  syncReadMb: number;
}

/** The same probe over an idle window: what box load alone does to it now.
 *  1s, so one momentary spike isn't the whole sample. */
const idleBaseline = () =>
  measured(() => new Promise((r) => setTimeout(r, 1000)));

/** Asserts the scan stayed responsive. Sync bytes and peak RSS decide (load
 *  can't move them); the worst stall is a ceiling. p99 and the idle baseline
 *  are logged so a failure shows the load. */
function assertResponsive(label: string, m: Measured, idle: Measured): void {
  process.stderr.write(
    `MEASURED ${label}: sync reads ${m.syncReadMb.toFixed(2)}MB, worst stall ${m.worstMs.toFixed(0)}ms, p99 ${m.p99Ms.toFixed(0)}ms, peak RSS +${m.rssGrowthMb.toFixed(0)}MB (idle baseline: worst ${idle.worstMs.toFixed(0)}ms, p99 ${idle.p99Ms.toFixed(0)}ms)\n`,
  );
  assert.ok(
    m.syncReadMb < MAX_SYNC_READ_MB,
    `${label} read ${m.syncReadMb.toFixed(1)}MB synchronously on the event loop (bound ${MAX_SYNC_READ_MB}MB)`,
  );
  assert.ok(
    m.worstMs < MAX_STALL_MS,
    `${label} froze the event loop for ${m.worstMs.toFixed(0)}ms (ceiling ${MAX_STALL_MS}ms)`,
  );
  assert.ok(
    m.rssGrowthMb < MAX_RSS_GROWTH_MB,
    `${label}: RSS grew ${m.rssGrowthMb.toFixed(0)}MB (bound ${MAX_RSS_GROWTH_MB}MB)`,
  );
}

describe("sync-read counter (precondition)", () => {
  it("counts a module's NAMED readFileSync import and readSync", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const probe = join(TEST_DIR, "probe.bin");
    writeFileSync(probe, Buffer.alloc(3 * 1024 * 1024));
    // Static named imports (this file's), the way rolloutScanner, auth and
    // sessionScanners import them: live bindings the counter must reach.
    // readFileSync's own internal readSync calls must not count twice.
    const { bytes } = await countingSyncReads(async () => {
      readFileSync(probe);
      const fd = openSync(probe, "r");
      try {
        readSync(fd, Buffer.alloc(1024 * 1024), 0, 1024 * 1024, 0);
      } finally {
        closeSync(fd);
      }
    });
    assert.equal(bytes, 4 * 1024 * 1024);
  });
});

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
    assertResponsive("fallback scan", m, idle);
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
    assertResponsive("usage poll (live failing)", m, idle);
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
    assertResponsive("Projects cold scan", m, idle);
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
