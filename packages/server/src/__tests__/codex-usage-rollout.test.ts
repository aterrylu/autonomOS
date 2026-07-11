import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const TEST_DIR = join(tmpdir(), `autonomos-codex-rollout-${randomUUID()}`);
process.env.CODEX_HOME = TEST_DIR;

const { readFreshestRollout, mapRolloutWindow } = await import(
  "../plugins/codex-usage/rolloutScanner.js"
);

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
  beforeEach(() => mkdirSync(SESSIONS, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns null when no rollout with rate_limits exists", () => {
    assert.equal(readFreshestRollout(), null);
  });

  it("picks the newest token_count event across recent rollouts", () => {
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
    const snap = readFreshestRollout();
    assert.ok(snap);
    assert.equal(snap.primary?.usedPercent, 71);
    assert.equal(snap.snapshotAt, "2026-06-28T00:00:00.000Z");
    assert.equal(snap.planType, "free");
  });

  it("prefers the newest EVENT timestamp even if another file has a newer mtime", () => {
    // File B has a newer mtime but an OLDER event; the scanner compares event
    // timestamps, so the newer event (in A) wins.
    writeRollout("a/rollout-a.jsonl", {
      timestamp: "2026-06-29T12:00:00.000Z",
      primaryPercent: 88,
      mtimeSec: 1000,
    });
    writeRollout("b/rollout-b.jsonl", {
      timestamp: "2026-06-20T00:00:00.000Z",
      primaryPercent: 10,
      mtimeSec: 9999,
    });
    const snap = readFreshestRollout();
    assert.equal(snap?.primary?.usedPercent, 88);
  });

  it("maps a populated secondary (paid-plan shape)", () => {
    writeRollout("p/rollout-p.jsonl", {
      timestamp: "2026-06-29T00:00:00.000Z",
      primaryPercent: 30,
      secondary: { used_percent: 5, window_minutes: 300 },
      planType: "pro",
      mtimeSec: 3000,
    });
    const snap = readFreshestRollout();
    assert.equal(snap?.secondary?.usedPercent, 5);
    assert.equal(snap?.secondary?.windowMinutes, 300);
    assert.equal(snap?.planType, "pro");
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
});
