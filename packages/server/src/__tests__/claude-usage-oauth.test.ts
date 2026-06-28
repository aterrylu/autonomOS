import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Isolate the Claude config dir so on-disk reads never touch the dev machine's
// real ~/.claude. (env-only at module load — no fs writes at import time.)
const TEST_DIR = join(tmpdir(), `autonomos-test-oauth-${randomUUID()}`);
process.env.CLAUDE_CONFIG_DIR = TEST_DIR;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { mapOAuthUsage, readOAuthToken, fetchOAuthUsage } = await import(
  "../plugins/claude-usage/oauthUsage.js"
);

type OAuthFetcher = Parameters<typeof fetchOAuthUsage>[0];
type OAuthTokenReader = Parameters<typeof fetchOAuthUsage>[1];

const CREDENTIALS_FILE = join(TEST_DIR, ".credentials.json");

describe("oauthUsage — mapOAuthUsage (pure mapper)", () => {
  it("maps a full OAuth usage response to RateLimitData windows", () => {
    const mapped = mapOAuthUsage({
      five_hour: { utilization: 42, resets_at: "2026-06-28T10:00:00Z" },
      seven_day: { utilization: 7, resets_at: "2026-07-05T00:00:00Z" },
      seven_day_sonnet: { utilization: 5, resets_at: "2026-07-05T00:00:00Z" },
      seven_day_opus: { utilization: 9, resets_at: "2026-07-05T00:00:00Z" },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1234,
        utilization: 24,
      },
    });
    assert.deepEqual(mapped.fiveHour, {
      utilization: 42,
      resetsAt: "2026-06-28T10:00:00Z",
    });
    assert.equal(mapped.sevenDay?.utilization, 7);
    assert.equal(mapped.sevenDaySonnet?.utilization, 5);
    assert.equal(mapped.sevenDayOpus?.utilization, 9);
    assert.deepEqual(mapped.extraUsage, {
      isEnabled: true,
      monthlyLimit: 5000,
      usedCredits: 1234,
      utilization: 24,
    });
  });

  it("nulls out a missing/nullable window and disabled extra usage", () => {
    const mapped = mapOAuthUsage({
      five_hour: { utilization: 0, resets_at: "2026-06-28T10:00:00Z" },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
    assert.equal(mapped.fiveHour?.utilization, 0);
    assert.equal(mapped.sevenDay, null);
    assert.equal(mapped.sevenDayOpus, null);
    assert.equal(mapped.sevenDaySonnet, null);
    assert.equal(mapped.extraUsage, null);
  });

  it("treats a window with no utilization as absent", () => {
    const mapped = mapOAuthUsage({ five_hour: { resets_at: "x" } });
    assert.equal(mapped.fiveHour, null);
  });
});

describe("oauthUsage — readOAuthToken (token-reader precedence)", () => {
  let savedUser: string | undefined;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedUser = process.env.USER;
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (savedUser === undefined) delete process.env.USER;
    else process.env.USER = savedUser;
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKEN (source 'env', never-stale)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
    const tok = readOAuthToken();
    assert.equal(tok?.accessToken, "env-oauth-token");
    assert.equal(tok?.source, "env");
    assert.equal(tok?.expiresAt, Number.POSITIVE_INFINITY);
  });

  it("falls back to the on-disk credentials file (source 'file')", () => {
    // Drop USER so the macOS keychain read short-circuits to null and the file
    // path is exercised deterministically on any platform.
    delete process.env.USER;
    writeFileSync(
      CREDENTIALS_FILE,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-token",
          expiresAt: 1893456000000,
          subscriptionType: "max",
        },
      }),
    );
    const tok = readOAuthToken();
    assert.equal(tok?.accessToken, "file-token");
    assert.equal(tok?.source, "file");
    assert.equal(tok?.expiresAt, 1893456000000);
    assert.equal(tok?.subscriptionType, "max");
  });

  it("returns null when no token is available anywhere", () => {
    delete process.env.USER; // no keychain
    // No file written, no env token.
    assert.equal(readOAuthToken(), null);
  });
});

describe("oauthUsage — fetchOAuthUsage (fetcher + token seams)", () => {
  const futureToken: OAuthTokenReader = () => ({
    accessToken: "good-token",
    expiresAt: Date.now() + 3_600_000,
    source: "keychain",
  });

  it("returns stale when the token expired before the call (no refresh)", async () => {
    let called = false;
    const fetcher: OAuthFetcher = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await fetchOAuthUsage(fetcher, () => ({
      accessToken: "expired",
      expiresAt: Date.now() - 1,
      source: "keychain",
    }));
    assert.equal(result.status, "stale");
    assert.equal(
      called,
      false,
      "must not call the endpoint with a stale token",
    );
  });

  it("returns unavailable when no token is available", async () => {
    const result = await fetchOAuthUsage(
      async () => ({ ok: true, status: 200, json: async () => ({}) }),
      () => null,
    );
    assert.equal(result.status, "unavailable");
  });

  it("sends the OAuth headers and returns ok with mapped-able data", async () => {
    let seen: Record<string, string> | null = null;
    const fetcher: OAuthFetcher = async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      seen = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 11, resets_at: "2026-06-28T10:00:00Z" },
        }),
      };
    };
    const result = await fetchOAuthUsage(fetcher, futureToken);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.data.five_hour?.utilization, 11);
    }
    assert.ok(seen);
    const headers = seen as unknown as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer good-token");
    assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
    assert.match(headers["User-Agent"], /^claude-code\//);
  });

  it("maps a 401 to unauthorized", async () => {
    const result = await fetchOAuthUsage(
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
      futureToken,
    );
    assert.equal(result.status, "unauthorized");
  });

  it("maps a 429 to rate_limited", async () => {
    const result = await fetchOAuthUsage(
      async () => ({ ok: false, status: 429, json: async () => ({}) }),
      futureToken,
    );
    assert.equal(result.status, "rate_limited");
  });

  it("maps a non-2xx (500) to unavailable", async () => {
    const result = await fetchOAuthUsage(
      async () => ({ ok: false, status: 500, json: async () => ({}) }),
      futureToken,
    );
    assert.equal(result.status, "unavailable");
  });

  it("maps a network throw to unavailable (no throw escapes)", async () => {
    const result = await fetchOAuthUsage(async () => {
      throw new Error("network down");
    }, futureToken);
    assert.equal(result.status, "unavailable");
  });
});
