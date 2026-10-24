import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

const TEST_DIR = join(tmpdir(), `autonomos-codex-scanner-${randomUUID()}`);
process.env.CODEX_HOME = TEST_DIR;

const { getCodexUsage, invalidateCodexUsageCache } = await import(
  "../plugins/codex-usage/scanner.js"
);
type Fetcher = Parameters<typeof getCodexUsage>[0];

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");
const makeJwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;

const SESSIONS = join(TEST_DIR, "sessions");

function writeAuth(exp: number): void {
  writeFileSync(
    join(TEST_DIR, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: makeJwt({ exp }),
        refresh_token: "rt.secret",
        account_id: "acct-1",
        id_token: makeJwt({
          email: "t@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        }),
      },
    }),
  );
}

let rolloutMtime = 1_000;
function writeRollout(primaryPercent: number): void {
  const dir = join(SESSIONS, "2026/06/28");
  mkdirSync(dir, { recursive: true });
  const event = {
    timestamp: "2026-06-28T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          used_percent: primaryPercent,
          window_minutes: 43_200,
          resets_at: 1_784_531_445,
        },
        secondary: null,
        plan_type: "free",
      },
    },
  };
  const file = join(dir, "rollout-2026-06-28T00-00-00-test.jsonl");
  writeFileSync(file, `${JSON.stringify(event)}\n`);
  // A distinct mtime per write, so a rewrite is always a CHANGED file.
  rolloutMtime += 1;
  utimesSync(file, rolloutMtime, rolloutMtime);
}

const liveOk =
  (primaryPercent: number): Fetcher =>
  async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: primaryPercent,
          reset_at: 1_784_600_000,
          limit_window_seconds: 604_800,
        },
        secondary_window: {
          used_percent: 9,
          reset_at: 1_784_531_445,
          limit_window_seconds: 18_000,
        },
      },
    }),
  });

const futureExp = () => Math.floor(Date.now() / 1000) + 86_400;
const pastExp = () => Math.floor(Date.now() / 1000) - 10;

describe("codex scanner — getCodexUsage (two-tier, read-only)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    invalidateCodexUsageCache();
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("live PRIMARY: valid token → real-time data, source=live", async () => {
    writeAuth(futureExp());
    const data = await getCodexUsage(liveOk(71));
    assert.equal(data.source, "live");
    assert.equal(data.primary?.usedPercent, 71);
    assert.equal(data.secondary?.usedPercent, 9);
    assert.equal(data.account.email, "t@example.com");
    assert.equal(data.error, undefined);
  });

  it("FALLBACK: live 401 + rollout present → last-known numbers WITH the credential failure stamped", async () => {
    writeAuth(futureExp());
    writeRollout(55);
    const fail: Fetcher = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const data = await getCodexUsage(fail);
    assert.equal(data.source, "rollout");
    assert.equal(data.primary?.usedPercent, 55);
    assert.equal(data.snapshotAt, "2026-06-28T00:00:00.000Z");
    // The failure must ride along: without it, an armed usage-queue pane held
    // forever with no re-auth warning whenever any rollout file existed.
    assert.equal(data.errorKind, "unauthorized");
    assert.match(data.error ?? "", /re-authenticate/);
  });

  it("EXPIRED token → rollout fallback stamped stale_token, NEVER calls the fetcher (no refresh)", async () => {
    writeAuth(pastExp());
    writeRollout(33);
    let called = false;
    const guard: Fetcher = async () => {
      called = true;
      throw new Error("fetcher must not be called for an expired token");
    };
    const data = await getCodexUsage(guard);
    assert.equal(
      called,
      false,
      "expired token must skip the live call entirely",
    );
    assert.equal(data.source, "rollout");
    assert.equal(data.primary?.usedPercent, 33);
    assert.equal(data.errorKind, "stale_token");
  });

  it("expired token + NO rollout → stale_token error", async () => {
    writeAuth(pastExp());
    const data = await getCodexUsage();
    assert.equal(data.errorKind, "stale_token");
    assert.equal(data.primary, null);
  });

  it("no auth + rollout: first miss serves UNSTAMPED (torn-read tolerance), second confirms the logout", async () => {
    writeRollout(20);
    // readCodexAuth returns null on ANY read failure (EACCES, a torn read
    // while the Codex CLI rewrites auth.json) — one miss must not flash a red
    // "logged out" banner + an unretractable queue notification.
    const first = await getCodexUsage();
    assert.equal(first.source, "rollout");
    assert.equal(first.primary?.usedPercent, 20);
    assert.equal(first.error, undefined, "first miss must not stamp");
    // A rollout only exists for someone who has used Codex — a CONFIRMED
    // missing login is a logout to surface, or an armed queue pane holds
    // forever.
    const second = await getCodexUsage();
    assert.equal(second.errorKind, "unauthorized");
    assert.match(second.error ?? "", /No Codex login found/);
  });

  it("a successful auth read resets the missing-auth streak", async () => {
    writeRollout(20);
    await getCodexUsage(); // miss 1
    writeAuth(futureExp());
    invalidateCodexUsageCache(); // drop the 60s cache, keep exercising reads
    const live = await getCodexUsage(liveOk(31));
    assert.equal(live.source, "live"); // auth readable again → streak reset
    rmSync(join(TEST_DIR, "auth.json"));
    const miss = await getCodexUsage();
    assert.equal(
      miss.error,
      undefined,
      "fresh single miss after a good read must hold again",
    );
  });

  it("no auth + no rollout → needsData (UI hides the item)", async () => {
    const data = await getCodexUsage();
    assert.equal(data.needsData, true);
    assert.equal(data.primary, null);
  });
});

describe("codex scanner — live failure reason + fallback backoff", () => {
  const status503: Fetcher = async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  });
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    invalidateCodexUsageCache();
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("names the cause: HTTP status, or the network error code", async () => {
    writeAuth(Math.floor(1_800_000_000_000 / 1000) + 86_400);
    writeRollout(40);
    const http = await getCodexUsage(status503);
    assert.equal(http.errorKind, "unavailable");
    assert.match(http.error ?? "", /Live Codex usage is failing \(HTTP 503\)/);

    invalidateCodexUsageCache();
    const refused: Fetcher = async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    };
    const net = await getCodexUsage(refused);
    assert.match(net.error ?? "", /\(ECONNREFUSED\)/);
  });

  it("a known file's new turns show every poll; a NEW file waits for a discovery walk, whose interval doubles until live answers", async () => {
    writeAuth(Math.floor(1_800_000_000_000 / 1000) + 86_400);
    const pct = async () =>
      (await getCodexUsage(status503)).primary?.usedPercent;
    const newRollout = (day: string, used: number) => {
      const dir = join(SESSIONS, "2026/07", day);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-2026-07-${day}T00-00-00-x.jsonl`);
      writeFileSync(
        file,
        `${JSON.stringify({ timestamp: `2026-07-${day}T00:00:00.000Z`, type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 300 } } } })}\n`,
      );
      rolloutMtime += 1;
      utimesSync(file, rolloutMtime, rolloutMtime);
    };
    writeRollout(10); // 2026-06-28, the known file
    assert.equal(await pct(), 10); // t=0: full walk

    newRollout("01", 20);
    mock.timers.tick(61_000); // recent walk due (60s) → found; next in 120s
    assert.equal(await pct(), 20);

    newRollout("02", 30);
    mock.timers.tick(61_000); // t=122: no walk due (next at 181)
    assert.equal(await pct(), 20, "a new file waits for the next walk");
    mock.timers.tick(61_000); // t=183: walk → found; next in 240s
    assert.equal(await pct(), 30);

    newRollout("03", 40);
    mock.timers.tick(61_000); // t=244: not due (next at 423)
    assert.equal(await pct(), 30);
    // Live answers once (t=305): discovery starts over, so the next outage
    // walks at once — without the reset the next walk is due only at t=423.
    mock.timers.tick(61_000);
    assert.equal((await getCodexUsage(liveOk(77))).source, "live");
    mock.timers.tick(61_000); // t=366
    assert.equal(await pct(), 40, "a new outage discovers immediately");
  });

  it("an already-known file's new events are served on the next poll, walk or not", async () => {
    writeAuth(Math.floor(1_800_000_000_000 / 1000) + 86_400);
    writeRollout(10);
    assert.equal((await getCodexUsage(status503)).primary?.usedPercent, 10);
    for (const [i, used] of [11, 12, 13].entries()) {
      writeRollout(used); // same file, a new turn
      mock.timers.tick(61_000 * (i + 1));
      assert.equal((await getCodexUsage(status503)).primary?.usedPercent, used);
    }
  });
});
