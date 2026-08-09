import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

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
  writeFileSync(join(dir, "rollout.jsonl"), `${JSON.stringify(event)}\n`);
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
