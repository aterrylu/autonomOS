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

const {
  mapOAuthUsage,
  readOAuthToken,
  fetchOAuthUsage,
  getOAuthToken,
  getLastCredentialFailure,
  invalidateOAuthTokenMemo,
  __setKeychainExecForTests,
  __setMemoClockForTests,
  __setTokenMemoTtlForTests,
} = await import("../plugins/claude-usage/oauthUsage.js");

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

  it("prefers CLAUDE_CODE_OAUTH_TOKEN (source 'env', never-stale)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
    const tok = await readOAuthToken();
    assert.equal(tok?.accessToken, "env-oauth-token");
    assert.equal(tok?.source, "env");
    assert.equal(tok?.expiresAt, Number.POSITIVE_INFINITY);
  });

  it("falls back to the on-disk credentials file (source 'file')", async () => {
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
    const tok = await readOAuthToken();
    assert.equal(tok?.accessToken, "file-token");
    assert.equal(tok?.source, "file");
    assert.equal(tok?.expiresAt, 1893456000000);
    assert.equal(tok?.subscriptionType, "max");
  });

  it("returns null when no token is available anywhere", async () => {
    delete process.env.USER; // no keychain
    // No file written, no env token.
    assert.equal(await readOAuthToken(), null);
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

describe("oauthUsage — getOAuthToken memo (one keychain read per TTL)", () => {
  let savedUser: string | undefined;
  let spawns = 0;
  /** Virtual time for the memo: TTL boundaries are crossed by advancing this,
   * never by sleeping, so a loaded box can't age an entry between two calls. */
  let now = 0;
  const advance = (ms: number) => {
    now += ms;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const blob = (accessToken: string, expiresAt = now + 3_600_000) =>
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
  /** A fake `security` that answers with `next()` after a short async delay —
   * async like the real execFile, so concurrent callers genuinely overlap. */
  const fakeKeychain = (next: () => string) =>
    __setKeychainExecForTests(async () => {
      spawns += 1;
      await sleep(5);
      return { stdout: next() };
    });

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedUser = process.env.USER;
    process.env.USER = "memo-test-user";
    spawns = 0;
    now = Date.now();
    __setMemoClockForTests(() => now);
  });
  afterEach(() => {
    __setKeychainExecForTests(null);
    __setTokenMemoTtlForTests(null);
    __setMemoClockForTests(null);
    if (savedUser === undefined) delete process.env.USER;
    else process.env.USER = savedUser;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("concurrent polls share ONE read, and memo hits spawn nothing", async () => {
    fakeKeychain(() => blob("tok-1"));
    const toks = await Promise.all(
      Array.from({ length: 10 }, () => getOAuthToken()),
    );
    assert.ok(toks.every((t) => t?.accessToken === "tok-1"));
    for (let i = 0; i < 5; i++) await getOAuthToken();
    assert.equal(spawns, 1);
  });

  it("re-reads once the hit TTL (60s) has elapsed — not a moment before", async () => {
    let n = 0;
    fakeKeychain(() => blob(`tok-${++n}`));
    assert.equal((await getOAuthToken())?.accessToken, "tok-1");
    advance(59_999);
    assert.equal((await getOAuthToken())?.accessToken, "tok-1");
    advance(1);
    assert.equal((await getOAuthToken())?.accessToken, "tok-2");
    assert.equal(spawns, 2);
  });

  it("re-reads an EXPIRED token on the miss TTL — not the hit TTL, and not every poll", async () => {
    let n = 0;
    fakeKeychain(() =>
      ++n === 1 ? blob("old", now + 5_000) : blob("rotated"),
    );
    assert.equal((await getOAuthToken())?.accessToken, "old");
    advance(6_000); // expired, but read 6s ago (< 10s miss TTL): no re-spawn per poll
    await getOAuthToken();
    await getOAuthToken();
    assert.equal(spawns, 1);
    advance(4_000); // 10s since the read → re-read picks up the rotation
    assert.equal((await getOAuthToken())?.accessToken, "rotated");
    assert.equal(spawns, 2);
  });

  it("a hung `security` read settles at the deadline and does not wedge later reads", async () => {
    // The deadline stays a REAL timer (30ms): the hung exec never settles, so
    // the deadline wins however loaded the box is. Only the memo is virtual.
    __setTokenMemoTtlForTests({
      hitMs: 60_000,
      missMs: 10_000,
      deadlineMs: 30,
    });
    let n = 0;
    __setKeychainExecForTests(() => {
      spawns += 1;
      return ++n === 1
        ? new Promise(() => {}) // never settles
        : Promise.resolve({ stdout: blob("after-hang") });
    });
    assert.equal(await getOAuthToken(), null);
    const f = getLastCredentialFailure();
    assert.ok(f?.source === "keychain" && f.timedOut);
    advance(10_000);
    assert.equal((await getOAuthToken())?.accessToken, "after-hang");
  });

  it("memoizes a miss only for the shorter miss TTL (10s)", async () => {
    __setKeychainExecForTests(async () => {
      spawns += 1;
      throw Object.assign(new Error("not found"), { code: 44, stderr: "" });
    });
    assert.equal(await getOAuthToken(), null);
    advance(9_999);
    assert.equal(await getOAuthToken(), null);
    assert.equal(spawns, 1);
    advance(1);
    await getOAuthToken();
    assert.equal(spawns, 2);
  });

  it("invalidateOAuthTokenMemo forces the next read", async () => {
    let n = 0;
    fakeKeychain(() => blob(`tok-${++n}`));
    await getOAuthToken();
    invalidateOAuthTokenMemo();
    assert.equal((await getOAuthToken())?.accessToken, "tok-2");
  });

  it("a read in flight across an invalidation cannot repopulate the memo", async () => {
    let n = 0;
    fakeKeychain(() => blob(`tok-${++n}`));
    const inFlight = getOAuthToken(); // read #1 starts
    invalidateOAuthTokenMemo(); // …and is superseded before it lands
    await inFlight;
    assert.equal((await getOAuthToken())?.accessToken, "tok-2");
    assert.equal(spawns, 2);
  });
});

describe("oauthUsage — getLastCredentialFailure (why there is no token)", () => {
  let savedUser: string | undefined;
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedUser = process.env.USER;
    process.env.USER = "diag-test-user";
  });
  afterEach(() => {
    __setKeychainExecForTests(null);
    if (savedUser === undefined) delete process.env.USER;
    else process.env.USER = savedUser;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("keeps the `security` exit code + stderr (exit 44 = item not found)", async () => {
    __setKeychainExecForTests(async () => {
      throw Object.assign(new Error("exit 44"), {
        code: 44,
        stderr:
          "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
      });
    });
    assert.equal(await readOAuthToken(), null);
    assert.deepEqual(getLastCredentialFailure(), {
      source: "keychain",
      exitCode: 44,
      signal: null,
      errno: null,
      stderr:
        "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
      timedOut: false,
      parseFailed: false,
    });
  });

  it("reports a timeout (locked keychain) distinctly from a nonzero exit", async () => {
    __setKeychainExecForTests(async () => {
      throw Object.assign(new Error("timed out"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
      });
    });
    await readOAuthToken();
    const f = getLastCredentialFailure();
    assert.equal(f?.source, "keychain");
    assert.ok(f?.source === "keychain" && f.timedOut && f.exitCode === null);
  });

  it("keeps a spawn-level error code (`security` binary missing → ENOENT)", async () => {
    __setKeychainExecForTests(async () => {
      throw Object.assign(new Error("spawn security ENOENT"), {
        code: "ENOENT",
      });
    });
    await readOAuthToken();
    const f = getLastCredentialFailure();
    assert.ok(f?.source === "keychain" && f.errno === "ENOENT");
    assert.ok(f?.source === "keychain" && f.exitCode === null);
  });

  it("blames the KEYCHAIN (not a missing file) when its entry is unparseable", async () => {
    __setKeychainExecForTests(async () => ({ stdout: "not-json" }));
    await readOAuthToken();
    const f = getLastCredentialFailure();
    assert.equal(f?.source, "keychain");
    assert.ok(f?.source === "keychain" && f.parseFailed);
  });

  it("an incomplete keychain blob falls through to the file store", async () => {
    __setKeychainExecForTests(async () => ({
      stdout: JSON.stringify({ claudeAiOauth: { accessToken: "no-expiry" } }),
    }));
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      CREDENTIALS_FILE,
      JSON.stringify({
        claudeAiOauth: { accessToken: "from-file", expiresAt: 1893456000000 },
      }),
    );
    const tok = await readOAuthToken();
    assert.equal(tok?.accessToken, "from-file");
    assert.equal(getLastCredentialFailure(), null);
  });

  it("the env override clears an earlier failure", async () => {
    __setKeychainExecForTests(async () => {
      throw Object.assign(new Error("x"), { code: 44, stderr: "" });
    });
    await readOAuthToken();
    assert.notEqual(getLastCredentialFailure(), null);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-tok";
    try {
      assert.equal((await readOAuthToken())?.source, "env");
      assert.equal(getLastCredentialFailure(), null);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("with no keychain applicable, reports the file store's errno", async () => {
    delete process.env.USER; // keychain not applicable
    await readOAuthToken();
    assert.deepEqual(getLastCredentialFailure(), {
      source: "file",
      errno: "ENOENT",
      parseFailed: false,
    });
  });

  it("reports a present-but-malformed credentials file as parseFailed", async () => {
    delete process.env.USER;
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(CREDENTIALS_FILE, "{not json");
    await readOAuthToken();
    assert.deepEqual(getLastCredentialFailure(), {
      source: "file",
      errno: null,
      parseFailed: true,
    });
  });

  it("invalidating the memo forgets the last failure too", async () => {
    __setKeychainExecForTests(async () => {
      throw Object.assign(new Error("x"), { code: 44, stderr: "" });
    });
    await getOAuthToken();
    assert.notEqual(getLastCredentialFailure(), null);
    invalidateOAuthTokenMemo();
    assert.equal(getLastCredentialFailure(), null);
  });

  it("clears the failure after a successful read", async () => {
    __setKeychainExecForTests(async () => {
      throw Object.assign(new Error("x"), { code: 36, stderr: "denied" });
    });
    await readOAuthToken();
    assert.notEqual(getLastCredentialFailure(), null);
    __setKeychainExecForTests(async () => ({
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "ok", expiresAt: Date.now() + 60_000 },
      }),
    }));
    assert.equal((await readOAuthToken())?.accessToken, "ok");
    assert.equal(getLastCredentialFailure(), null);
  });
});
