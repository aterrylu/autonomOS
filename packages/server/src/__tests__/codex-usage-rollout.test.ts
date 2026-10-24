import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const TEST_DIR = join(tmpdir(), `autonomos-codex-rollout-${randomUUID()}`);
process.env.CODEX_HOME = TEST_DIR;

const {
  readFreshestRollout,
  mapRolloutWindow,
  lastRateLimitsInFile,
  clearRolloutCache,
  TAIL_CHUNK_BYTES,
  MAX_TAIL_BYTES,
} = await import("../plugins/codex-usage/rolloutScanner.js");

const SESSIONS = join(TEST_DIR, "sessions");

/** Write a rollout file with a token_count event carrying rate_limits, and set
 *  its mtime so mtime-ordering is deterministic. */
function writeRollout(
  relPath: string,
  opts: {
    timestamp: string;
    primaryPercent?: number;
    secondary?: { used_percent: number; window_minutes: number } | null;
    planType?: string;
    mtimeSec: number;
  },
): void {
  const full = join(SESSIONS, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const event = {
    timestamp: opts.timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: "codex",
        primary: {
          used_percent: opts.primaryPercent ?? 50,
          window_minutes: 43_200,
          resets_at: 1_784_531_445,
        },
        secondary: opts.secondary ?? null,
        credits: null,
        plan_type: opts.planType ?? "free",
      },
    },
  };
  // A leading non-token_count line ensures reverse-scan skips noise correctly.
  const noise = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message" },
  });
  writeFileSync(full, `${noise}\n${JSON.stringify(event)}\n`);
  utimesSync(full, opts.mtimeSec, opts.mtimeSec);
}

describe("codex rolloutScanner — readFreshestRollout", () => {
  beforeEach(() => {
    mkdirSync(SESSIONS, { recursive: true });
    clearRolloutCache();
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns null when no rollout with rate_limits exists", async () => {
    assert.equal(await readFreshestRollout(), null);
  });

  it("picks the newest token_count event across recent rollouts", async () => {
    writeRollout("2026/06/27/rollout-old.jsonl", {
      timestamp: "2026-06-27T00:00:00.000Z",
      primaryPercent: 40,
      mtimeSec: 1000,
    });
    writeRollout("2026/06/28/rollout-new.jsonl", {
      timestamp: "2026-06-28T00:00:00.000Z",
      primaryPercent: 71,
      mtimeSec: 2000,
    });
    const snap = await readFreshestRollout();
    assert.ok(snap);
    assert.equal(snap.primary?.usedPercent, 71);
    assert.equal(snap.snapshotAt, "2026-06-28T00:00:00.000Z");
    assert.equal(snap.planType, "free");
  });

  it("prefers the newest EVENT timestamp even if another file has a newer mtime", async () => {
    // File B has a newer mtime but an OLDER event; the scanner compares event
    // timestamps, so the newer event (in A) wins.
    writeRollout("2026/06/29/rollout-a.jsonl", {
      timestamp: "2026-06-29T12:00:00.000Z",
      primaryPercent: 88,
      mtimeSec: 1000,
    });
    writeRollout("2026/06/20/rollout-b.jsonl", {
      timestamp: "2026-06-20T00:00:00.000Z",
      primaryPercent: 10,
      mtimeSec: 9999,
    });
    const snap = await readFreshestRollout();
    assert.equal(snap?.primary?.usedPercent, 88);
  });

  it("maps a populated secondary (paid-plan shape)", async () => {
    writeRollout("2026/06/29/rollout-p.jsonl", {
      timestamp: "2026-06-29T00:00:00.000Z",
      primaryPercent: 30,
      secondary: { used_percent: 5, window_minutes: 300 },
      planType: "pro",
      mtimeSec: 3000,
    });
    const snap = await readFreshestRollout();
    assert.equal(snap?.secondary?.usedPercent, 5);
    assert.equal(snap?.secondary?.windowMinutes, 300);
    assert.equal(snap?.planType, "pro");
  });
});

/** A token_count line (no trailing newline). */
function tcLine(timestamp: string, used: number, pad = ""): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      note: pad,
      rate_limits: { primary: { used_percent: used, window_minutes: 300 } },
    },
  });
}

describe("codex rolloutScanner — backward tail read", () => {
  const FILE = join(TEST_DIR, "tail.jsonl");
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  async function scan(content: string | Buffer) {
    writeFileSync(FILE, content);
    return lastRateLimitsInFile(FILE, Buffer.byteLength(content));
  }

  it("returns the LAST event, skipping a trailing line still being written", async () => {
    const found = await scan(
      `${tcLine("2026-01-01T00:00:00.000Z", 1)}\n${tcLine("2026-01-02T00:00:00.000Z", 2)}\n{"timestamp":"2026-01-03","payload":{"rate_limits`,
    );
    assert.equal(found?.timestamp, "2026-01-02T00:00:00.000Z");
  });

  it("finds an event that is the file's only (first) line, with no trailing newline", async () => {
    const found = await scan(tcLine("2026-01-01T00:00:00.000Z", 7));
    assert.equal(found?.timestamp, "2026-01-01T00:00:00.000Z");
  });

  it("assembles an event line spanning several chunks, with multi-byte chars across the boundaries", async () => {
    // 3+ chunks of 3-byte characters: chunk edges land mid-character.
    const pad = "€".repeat(TAIL_CHUNK_BYTES);
    const line = tcLine("2026-01-05T00:00:00.000Z", 42, pad);
    const found = await scan(`noise\n${line}\n${"y".repeat(1000)}\n`);
    assert.equal(found?.timestamp, "2026-01-05T00:00:00.000Z");
    assert.equal(found?.rateLimits.primary?.used_percent, 42);
  });

  it("finds an event several chunks back behind turn noise", async () => {
    const noise = `${JSON.stringify({ type: "response_item", text: "z".repeat(5000) })}\n`;
    const body = `${tcLine("2026-01-06T00:00:00.000Z", 9)}\n${noise.repeat(Math.ceil((3 * TAIL_CHUNK_BYTES) / noise.length))}`;
    const found = await scan(body);
    assert.equal(found?.timestamp, "2026-01-06T00:00:00.000Z");
  });

  it("treats an event further back than the cap as no event (bounded read)", async () => {
    const noise = `${"q".repeat(4095)}\n`;
    const body = `${tcLine("2026-01-07T00:00:00.000Z", 3)}\n${noise.repeat(MAX_TAIL_BYTES / noise.length + 1)}`;
    assert.equal(await scan(body), null);
  });

  it("an unchanged file is served from cache; a changed one is re-read", async () => {
    clearRolloutCache();
    const path = join(SESSIONS, "2026/07/01/rollout-c.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${tcLine("2026-07-01T00:00:00.000Z", 11)}\n`);
    utimesSync(path, 5000, 5000);
    assert.equal((await readFreshestRollout())?.primary?.usedPercent, 11);
    // Same size + same mtime → not re-read (the 22 is never seen).
    writeFileSync(path, `${tcLine("2026-07-01T00:00:00.000Z", 22)}\n`);
    utimesSync(path, 5000, 5000);
    assert.equal((await readFreshestRollout())?.primary?.usedPercent, 11);
    // An appended turn changes size + mtime → re-read.
    writeFileSync(
      path,
      `${tcLine("2026-07-01T00:00:00.000Z", 22)}\n${tcLine("2026-07-01T01:00:00.000Z", 33)}\n`,
    );
    utimesSync(path, 6000, 6000);
    assert.equal((await readFreshestRollout())?.primary?.usedPercent, 33);
  });
});

describe("codex rolloutScanner — mapRolloutWindow", () => {
  it("converts resets_at epoch seconds → ISO and null-guards", () => {
    const w = mapRolloutWindow({
      used_percent: 71,
      window_minutes: 43_200,
      resets_at: 1_784_531_445,
    });
    assert.deepEqual(w, {
      usedPercent: 71,
      windowMinutes: 43_200,
      resetsAt: new Date(1_784_531_445_000).toISOString(),
    });
    assert.equal(mapRolloutWindow(null), null);
    assert.equal(mapRolloutWindow({ window_minutes: 5 }), null);
  });

  it("tolerates numeric STRINGS like the live path — the fallback has no second chance", () => {
    const w = mapRolloutWindow({
      used_percent: "34" as never,
      window_minutes: "10080" as never,
      resets_at: "1784531445" as never,
    });
    assert.deepEqual(w, {
      usedPercent: 34,
      windowMinutes: 10_080,
      resetsAt: new Date(1_784_531_445_000).toISOString(),
    });
    assert.equal(mapRolloutWindow({ used_percent: "abc" as never }), null);
  });
});
