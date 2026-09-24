import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

// Isolate EVERY path the diagnosis reads before importing: settings, Claude
// Code's config dir, and HOME (readClaudeConfigHints falls back to
// ~/.claude.json). Strip ambient auth env so the dev shell can't leak in.
const TEST_DIR = join(tmpdir(), `autonomos-test-usage-diag-${randomUUID()}`);
// autonomOS settings and Claude Code's config live in SEPARATE dirs, so a
// test writing one settings.json can't silently feed the other.
const CLAUDE_DIR = join(TEST_DIR, "claude");
// No fs writes at import (Linux e2e convention): dirs are made in before().
before(() => mkdirSync(CLAUDE_DIR, { recursive: true }));
after(() => rmSync(TEST_DIR, { recursive: true, force: true }));
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
process.env.HOME = TEST_DIR;
for (const k of [
  "CLAUDE_SESSION_KEY",
  "CLAUDE_ORG_ID",
  "CLAUDE_SESSION_COOKIE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]) {
  delete process.env[k];
}

const {
  diagnoseFetchFailure,
  diagnoseMissingLogin,
  diagnoseNoWindows,
  planLabel,
} = await import("../plugins/claude-usage/credentialDiagnosis.js");
const {
  mapOAuthUsage,
  fetchOAuthUsage,
  readClaudeConfigHints,
  __setOAuthTokenReaderForTests,
  __setOAuthFetcherForTests,
  __setKeychainExecForTests,
  getOAuthToken,
} = await import("../plugins/claude-usage/oauthUsage.js");
const {
  getRateLimits,
  invalidateCache,
  __resetDiagnosisLogForTests,
  __expireCacheForTests,
} = await import("../plugins/claude-usage/scanner.js");
const { normalizeClaudeUsage } = await import("../usageQueue.js");
type OAuthUsageRaw = Parameters<typeof mapOAuthUsage>[0];

/** Terry's REAL Max-plan /api/oauth/usage response (home machine, one
 *  read-only GET 2026-09-24), trimmed to the fields any mapper reads. Both the
 *  flat fields AND `limits[]` are populated and agree — the adjacent-regression
 *  fixture: this account's bar must not change. */
const MAX_HOME: OAuthUsageRaw = {
  five_hour: { utilization: 13, resets_at: "2026-09-24T10:49:59.905647+00:00" },
  seven_day: { utilization: 4, resets_at: "2026-09-30T21:59:59.905669+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: undefined,
    used_credits: undefined,
    utilization: null,
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 13,
      resets_at: "2026-09-24T10:49:59.905647+00:00",
      scope: null,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 4,
      resets_at: "2026-09-30T21:59:59.905669+00:00",
      scope: null,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      resets_at: "2026-09-30T22:00:00+00:00",
      scope: { model: { id: null, display_name: "Fable" } },
    },
  ],
  spend: { enabled: false, limit: null },
};

/** The reported Team-plan shape: flat window fields null, the real 5h/7d
 *  windows only in `limits[]`. Before the fix this mapped to four nulls — the
 *  silent gray "n/a". */
const TEAM_LIMITS_ONLY: OAuthUsageRaw = {
  five_hour: null,
  seven_day: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: true,
    monthly_limit: 5000,
    used_credits: 1200,
    utilization: 24,
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 38,
      resets_at: "2026-09-24T12:00:00Z",
      scope: null,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 61,
      resets_at: "2026-09-29T00:00:00Z",
      scope: null,
    },
  ],
  spend: { enabled: true, limit: { amount_minor: 5000 } },
};

describe("mapOAuthUsage — limits[] (flat fields win, limits[] fills gaps)", () => {
  it("ADJACENT REGRESSION: Terry's Max payload maps to exactly the flat-field windows", () => {
    const withLimits = mapOAuthUsage(MAX_HOME);
    const flatOnly = mapOAuthUsage({ ...MAX_HOME, limits: null });
    assert.deepEqual(withLimits.fiveHour, flatOnly.fiveHour);
    assert.deepEqual(withLimits.sevenDay, flatOnly.sevenDay);
    assert.deepEqual(withLimits.fiveHour, {
      utilization: 13,
      resetsAt: "2026-09-24T10:49:59.905647+00:00",
    });
    assert.equal(withLimits.sevenDay?.utilization, 4);
    assert.equal(withLimits.sevenDaySonnet, null);
    assert.equal(withLimits.sevenDayOpus, null);
    // The one addition: the model-scoped weekly the response names.
    assert.deepEqual(withLimits.extraWindows, [
      {
        id: "claude-weekly-scoped-fable",
        label: "Fable 7d",
        utilization: 0,
        resetsAt: "2026-09-30T22:00:00+00:00",
        span: "7d",
      },
    ]);
  });

  it("THE FIX: a Team payload with null flat fields reads its windows from limits[]", () => {
    const m = mapOAuthUsage(TEAM_LIMITS_ONLY);
    assert.deepEqual(m.fiveHour, {
      utilization: 38,
      resetsAt: "2026-09-24T12:00:00Z",
    });
    assert.deepEqual(m.sevenDay, {
      utilization: 61,
      resetsAt: "2026-09-29T00:00:00Z",
    });
    assert.deepEqual(m.extraWindows, []);
    assert.equal(m.extraUsage?.usedCredits, 1200);
  });

  it("flat fields win when both disagree (no change for accounts that render today)", () => {
    const m = mapOAuthUsage({
      five_hour: { utilization: 10, resets_at: "a" },
      limits: [
        { kind: "session", group: "session", percent: 99, resets_at: "b" },
      ],
    });
    assert.deepEqual(m.fiveHour, { utilization: 10, resetsAt: "a" });
    assert.deepEqual(m.extraWindows, []);
  });

  it("routes scoped Sonnet/Opus weeklies into their slots and 'All models' into 7d", () => {
    const m = mapOAuthUsage({
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 22,
          scope: { model: { display_name: "Claude Sonnet" } },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 33,
          scope: { model: { display_name: "Opus" } },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 44,
          scope: { model: { display_name: "All models" } },
        },
      ],
    });
    assert.equal(m.sevenDaySonnet?.utilization, 22);
    assert.equal(m.sevenDayOpus?.utilization, 33);
    assert.equal(m.sevenDay?.utilization, 44);
    assert.deepEqual(m.extraWindows, []);
  });

  it("FUTURE-SAFETY: an unknown limit kind becomes a named window — never dropped", () => {
    const m = mapOAuthUsage({
      limits: [
        { kind: "daily_burst", group: "daily", percent: "57", resets_at: null },
        { kind: "session_scoped", group: "session", percent: 12 },
      ],
    });
    assert.deepEqual(
      m.extraWindows.map((w) => [w.id, w.label, w.utilization]),
      [
        ["claude-daily-burst", "Daily Burst", 57],
        ["claude-session-scoped", "Session Scoped 5h", 12],
      ],
    );
  });

  it("skips malformed entries without losing their siblings, and de-dups ids", () => {
    const m = mapOAuthUsage({
      limits: [
        null as never,
        "junk" as never,
        { kind: "weekly_all", percent: "not a number" },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 5,
          scope: { model: { display_name: "GPT 5" } },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 6,
          scope: { model: { display_name: "GPT 5" } },
        },
      ],
    });
    assert.equal(m.sevenDay, null);
    assert.deepEqual(
      m.extraWindows.map((w) => w.id),
      ["claude-weekly-scoped-gpt-5", "claude-weekly-scoped-gpt-5-2"],
    );
  });

  it("a second limits[] entry for a filled slot is kept as a named window, not dropped", () => {
    const m = mapOAuthUsage({
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 10,
          scope: { model: { display_name: "Sonnet 4" } },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 90,
          scope: { model: { display_name: "Sonnet 4.5" } },
        },
      ],
    });
    assert.equal(m.sevenDaySonnet?.utilization, 10);
    assert.deepEqual(
      m.extraWindows.map((w) => [w.label, w.utilization]),
      [["Sonnet 4.5 7d", 90]],
    );
  });

  it("logs skipped limits[] entries once instead of dropping them silently", () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warned.push(a.join(" "));
    };
    try {
      const body = {
        limits: [
          { kind: "session", group: "session", percent: 10 },
          { kind: "weekly_all", group: "weekly", percent: null },
        ],
      };
      mapOAuthUsage(body);
      mapOAuthUsage(body);
    } finally {
      console.warn = orig;
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /skipped 1 unreadable entry \(kinds: weekly_all\)/);
  });

  it("a flat window with a non-numeric utilization is not a window", () => {
    const m = mapOAuthUsage({
      five_hour: { utilization: {} as never, resets_at: "x" },
      seven_day: { utilization: "12" as never, resets_at: "y" },
    });
    assert.equal(m.fiveHour, null);
    assert.deepEqual(m.sevenDay, { utilization: 12, resetsAt: "y" });
  });

  it("weekly_all takes the overall slot even when an unscoped weekly_scoped comes first", () => {
    const m = mapOAuthUsage({
      limits: [
        { kind: "weekly_scoped", group: "weekly", percent: 3, scope: null },
        { kind: "weekly_all", group: "weekly", percent: 70 },
      ],
    });
    assert.equal(m.sevenDay?.utilization, 70);
  });

  it("named windows carry their span from the response's group", () => {
    const [fable] = mapOAuthUsage(MAX_HOME).extraWindows;
    assert.equal(fable.span, "7d");
    const [odd] = mapOAuthUsage({
      limits: [{ kind: "daily_burst", group: "daily", percent: 1 }],
    }).extraWindows;
    assert.equal(odd.span, undefined);
  });

  it("the usage queue caps on named windows under the panel's label", () => {
    const m = mapOAuthUsage(MAX_HOME);
    const q = normalizeClaudeUsage({
      ...m,
      account: {},
      fetchedAt: new Date().toISOString(),
    });
    assert.deepEqual(
      q.windows.map((w) => [w.label, w.utilization]),
      [
        ["5h", 13],
        ["7d", 4],
        ["Fable 7d", 0],
      ],
    );
  });
});

describe("diagnosis codes — server and dashboard copies can't drift", () => {
  it("every server code has a dashboard label, and vice versa", () => {
    const server = readFileSync(
      join(
        import.meta.dirname,
        "../plugins/claude-usage/credentialDiagnosis.ts",
      ),
      "utf-8",
    );
    const dashboard = readFileSync(
      join(
        import.meta.dirname,
        "../../../dashboard/src/plugins/claude-usage/diagnosis.ts",
      ),
      "utf-8",
    );
    const union = server.match(/export type UsageDiagnosisCode =([^;]+);/)?.[1];
    assert.ok(union, "server union not found");
    const serverCodes = [...union.matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1])
      .sort();
    const labels = dashboard.match(/SHORT_LABELS[^{]*\{([^}]+)\}/)?.[1];
    assert.ok(labels, "dashboard SHORT_LABELS not found");
    const dashCodes = [...labels.matchAll(/^\s*([a-z_]+):/gm)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(dashCodes, serverCodes);
  });
});

describe("credentialDiagnosis — missing login", () => {
  const noAuth = {
    hasOAuthAccount: false,
    apiKeyConfigured: false,
    cloudProvider: null,
    configDirOverride: false,
    configReadable: true,
    credentialsPath: "~/.claude/.credentials.json",
  } as const;

  it("keychain timeout → locked", () => {
    const d = diagnoseMissingLogin({
      platform: "darwin",
      failures: [{ source: "keychain", exitCode: null, timedOut: true }],
      auth: noAuth,
    });
    assert.equal(d.code, "keychain_timeout");
  });

  for (const exitCode of [36, 51, 128]) {
    it(`keychain exit ${exitCode} → denied`, () => {
      const d = diagnoseMissingLogin({
        platform: "darwin",
        failures: [{ source: "keychain", exitCode, timedOut: false }],
        auth: noAuth,
      });
      assert.equal(d.code, "keychain_denied");
    });
  }

  it("keychain exit 44 (item not found) → plain no-login, naming the keychain", () => {
    const d = diagnoseMissingLogin({
      platform: "darwin",
      failures: [{ source: "keychain", exitCode: 44, timedOut: false }],
      auth: noAuth,
    });
    assert.equal(d.code, "no_login");
    assert.match(d.summary, /macOS keychain/);
  });

  it("file present but unparseable → malformed; EACCES → unreadable", () => {
    assert.equal(
      diagnoseMissingLogin({
        platform: "linux",
        failures: [{ source: "file", errno: null, parseFailed: true }],
        auth: noAuth,
      }).code,
      "credentials_malformed",
    );
    assert.equal(
      diagnoseMissingLogin({
        platform: "linux",
        failures: [{ source: "file", errno: "EACCES", parseFailed: false }],
        auth: noAuth,
      }).code,
      "credentials_unreadable",
    );
  });

  it("a keychain blob that isn't usable credentials reads as malformed, not missing", () => {
    assert.equal(
      diagnoseMissingLogin({
        platform: "darwin",
        failures: [{ source: "keychain", exitCode: 0, parseFailed: true }],
        auth: noAuth,
      }).code,
      "credentials_malformed",
    );
    // …and its summary names the keychain, not "the credentials file".
    assert.match(
      diagnoseMissingLogin({
        platform: "darwin",
        failures: [{ source: "keychain", exitCode: 0, parseFailed: true }],
        auth: noAuth,
      }).summary,
      /macOS keychain/,
    );
  });

  it("Bedrock / Vertex / API-key auth say there is no subscription usage", () => {
    assert.equal(
      diagnoseMissingLogin({
        platform: "linux",
        failures: [],
        auth: { ...noAuth, cloudProvider: "bedrock" },
      }).code,
      "cloud_provider_auth",
    );
    assert.equal(
      diagnoseMissingLogin({
        platform: "linux",
        failures: [],
        auth: { ...noAuth, apiKeyConfigured: true },
      }).code,
      "api_key_auth",
    );
    // An API key alongside a real oauthAccount is NOT api-key auth.
    assert.equal(
      diagnoseMissingLogin({
        platform: "linux",
        failures: [],
        auth: { ...noAuth, apiKeyConfigured: true, hasOAuthAccount: true },
      }).code,
      "login_unreadable",
    );
  });

  it("an oauthAccount with no readable token is 'login unreadable', not 'no login'", () => {
    const d = diagnoseMissingLogin({
      platform: "darwin",
      failures: [],
      auth: { ...noAuth, hasOAuthAccount: true },
    });
    assert.equal(d.code, "login_unreadable");
    assert.doesNotMatch(d.hint, /log in with a claude\.ai account/);
  });

  it("never guesses API-key auth from an unreadable config", () => {
    assert.notEqual(
      diagnoseMissingLogin({
        platform: "linux",
        failures: [],
        auth: { ...noAuth, apiKeyConfigured: true, configReadable: false },
      }).code,
      "api_key_auth",
    );
  });

  it("names the real credentials path", () => {
    const d = diagnoseMissingLogin({
      platform: "linux",
      failures: [],
      auth: { ...noAuth, credentialsPath: "/srv/cc/.credentials.json" },
    });
    assert.match(d.summary, /\/srv\/cc\/\.credentials\.json/);
  });

  it("names CLAUDE_CONFIG_DIR in the no-login hint", () => {
    const d = diagnoseMissingLogin({
      platform: "linux",
      failures: [],
      auth: { ...noAuth, configDirOverride: true },
    });
    assert.match(d.hint, /CLAUDE_CONFIG_DIR/);
    assert.doesNotMatch(d.summary, /keychain/);
  });
});

describe("credentialDiagnosis — fetch failures and empty responses", () => {
  it("maps each fetch outcome to its own code", () => {
    const code = (o: Parameters<typeof diagnoseFetchFailure>[0]) =>
      diagnoseFetchFailure(o).code;
    assert.equal(code({ status: "stale" }), "token_expired");
    assert.equal(code({ status: "unauthorized" }), "token_rejected");
    assert.equal(code({ status: "rate_limited" }), "rate_limited");
    assert.equal(
      code({ status: "unavailable", cause: "http", httpStatus: 403 }),
      "usage_forbidden",
    );
    assert.equal(
      code({ status: "unavailable", cause: "http", httpStatus: 502 }),
      "http_error",
    );
    assert.equal(
      code({ status: "unavailable", cause: "parse" }),
      "unexpected_response",
    );
    assert.equal(
      code({ status: "unavailable", cause: "network" }),
      "network_unreachable",
    );
  });

  it("marks only self-clearing causes transient (a 404 or 403 is not)", () => {
    const t = (o: Parameters<typeof diagnoseFetchFailure>[0]) =>
      diagnoseFetchFailure(o).transient === true;
    assert.equal(t({ status: "rate_limited" }), true);
    assert.equal(t({ status: "unavailable", cause: "network" }), true);
    assert.equal(
      t({ status: "unavailable", cause: "http", httpStatus: 503 }),
      true,
    );
    assert.equal(
      t({ status: "unavailable", cause: "http", httpStatus: 404 }),
      false,
    );
    assert.equal(
      t({ status: "unavailable", cause: "http", httpStatus: 403 }),
      false,
    );
    assert.equal(t({ status: "unavailable", cause: "parse" }), false);
  });

  it("the expired-token hint never suggests autonomOS refresh anything", () => {
    const d = diagnoseFetchFailure({ status: "stale" });
    assert.match(d.hint, /never refreshes/);
  });

  it("no-windows does NOT claim the account has no limits (the Team report had them)", () => {
    const d = diagnoseNoWindows({
      plan: { organizationType: "claude_team" },
      spend: { spendEnabled: true, hasLimitsArray: true },
    });
    assert.equal(d.code, "no_rolling_limits");
    assert.match(d.summary, /\(Team plan\)/);
    assert.match(d.hint, /\/usage/);
    assert.doesNotMatch(d.summary, /no .*limits on/);
  });

  it("planLabel prettifies plan ids and never needs a name", () => {
    assert.equal(
      planLabel({ organizationType: "claude_enterprise" }),
      "Enterprise",
    );
    assert.equal(planLabel({ seatTier: "team_premium" }), "Team Premium");
    assert.equal(planLabel({ subscriptionType: "max" }), "Max");
    assert.equal(planLabel({}), undefined);
  });
});

describe("fetchOAuthUsage — failure causes", () => {
  const token = () => ({
    accessToken: "t",
    expiresAt: Date.now() + 3_600_000,
    source: "env" as const,
  });
  const reply = (status: number, body: () => Promise<unknown>) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: body,
  });

  it("403 → unavailable/http/403; non-JSON 200 → parse; throw → network", async () => {
    assert.deepEqual(
      await fetchOAuthUsage(
        reply(403, async () => ({})),
        token,
      ),
      { status: "unavailable", cause: "http", httpStatus: 403 },
    );
    assert.deepEqual(
      await fetchOAuthUsage(
        reply(200, async () => {
          throw new SyntaxError("Unexpected token <");
        }),
        token,
      ),
      { status: "unavailable", cause: "parse" },
    );
    assert.deepEqual(
      await fetchOAuthUsage(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
      }, token),
      { status: "unavailable", cause: "network" },
    );
    // Valid JSON that isn't an object must not reach the mapper (it threw).
    for (const body of [null, [], 5]) {
      assert.deepEqual(
        await fetchOAuthUsage(
          reply(200, async () => body),
          token,
        ),
        { status: "unavailable", cause: "parse" },
      );
    }
  });
});

describe("getRateLimits — diagnosis on every non-happy answer", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  const token = {
    accessToken: `tok-${randomUUID()}`,
    expiresAt: Date.now() + 3_600_000,
    source: "keychain" as const,
    subscriptionType: "team",
  };

  beforeEach(() => {
    invalidateCache();
    __resetDiagnosisLogForTests();
    warnings.length = 0;
    console.warn = (...a: unknown[]) => {
      warnings.push(a.join(" "));
    };
    console.log = () => {};
    rmSync(join(CLAUDE_DIR, ".claude.json"), { force: true });
    rmSync(join(CLAUDE_DIR, "settings.json"), { force: true });
    rmSync(join(TEST_DIR, "settings.json"), { force: true });
  });
  afterEach(() => {
    console.warn = origWarn;
    console.log = origLog;
    __setOAuthTokenReaderForTests(null);
    __setOAuthFetcherForTests(null);
    invalidateCache();
  });

  const serve = (body: OAuthUsageRaw, status = 200) =>
    __setOAuthFetcherForTests(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));

  it("a Team payload renders numbers, with no diagnosis and no warning", async () => {
    __setOAuthTokenReaderForTests(() => token);
    serve(TEAM_LIMITS_ONLY);
    const d = await getRateLimits();
    assert.equal(d.fiveHour?.utilization, 38);
    assert.equal(d.sevenDay?.utilization, 61);
    assert.equal(d.diagnosis, undefined);
    assert.equal(warnings.length, 0);
  });

  it("a truly empty 200 gets no_rolling_limits with the plan label from ~/.claude.json", async () => {
    writeFileSync(
      join(CLAUDE_DIR, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          organizationType: "claude_team",
          billingType: "stripe_subscription",
          organizationName: "MUST-NOT-LEAK",
          emailAddress: "must-not-leak@example.com",
        },
      }),
    );
    __setOAuthTokenReaderForTests(() => token);
    serve({ five_hour: null, seven_day: null, limits: [] });
    const d = await getRateLimits();
    assert.equal(d.diagnosis?.code, "no_rolling_limits");
    assert.match(d.diagnosis?.summary ?? "", /Team plan/);
    const text = JSON.stringify(d.diagnosis) + warnings.join("\n");
    assert.doesNotMatch(text, /MUST-NOT-LEAK|must-not-leak/);
  });

  it("no token → needsSetup with a no_login diagnosis naming CLAUDE_CONFIG_DIR", async () => {
    __setOAuthTokenReaderForTests(() => null);
    const d = await getRateLimits();
    assert.equal(d.needsSetup, true);
    assert.equal(d.diagnosis?.code, "no_login");
    // This suite sets CLAUDE_CONFIG_DIR for the server process.
    assert.match(d.diagnosis?.hint ?? "", /CLAUDE_CONFIG_DIR/);
  });

  it("API-key auth is detected from Claude Code's config (names only)", async () => {
    writeFileSync(
      join(CLAUDE_DIR, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-SECRET" } }),
    );
    assert.equal(readClaudeConfigHints().auth.apiKeyConfigured, true);
    __setOAuthTokenReaderForTests(() => null);
    const d = await getRateLimits();
    assert.equal(d.diagnosis?.code, "api_key_auth");
    assert.doesNotMatch(JSON.stringify(d) + warnings.join(), /SECRET/);
  });

  it("a session key with no windows says 'session key', not 'Claude login'", () => {
    const d = diagnoseNoWindows({ plan: {}, spend: {}, viaSessionKey: true });
    assert.match(d.summary, /^Your session key works/);
  });

  it("a 403 after a good reading says 'refused', not 'unreachable', on the stale marker", async () => {
    __setOAuthTokenReaderForTests(() => token);
    serve(TEAM_LIMITS_ONLY);
    await getRateLimits(); // last-good
    __expireCacheForTests();
    serve({}, 403);
    const d = await getRateLimits();
    assert.equal(d.fiveHour?.utilization, 38, "numbers still served");
    assert.equal(d.diagnosis?.code, "usage_forbidden");
    assert.match(d.error ?? "", /refused the usage request \(HTTP 403\)/);
    assert.doesNotMatch(d.error ?? "", /unreachable/);
  });

  it("403 no longer claims 'your login is fine'", async () => {
    __setOAuthTokenReaderForTests(() => token);
    serve({}, 403);
    const d = await getRateLimits();
    assert.equal(d.diagnosis?.code, "usage_forbidden");
    assert.equal(d.errorKind, "unavailable"); // fallback semantics unchanged
    assert.doesNotMatch(d.error ?? "", /login is fine/);
  });

  it("ignores ANTHROPIC_API_KEY in the SERVER's env (the user's claude may not have it)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-server-only";
    try {
      assert.equal(readClaudeConfigHints().auth.apiKeyConfigured, false);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("auto-detect off with no key names that cause", async () => {
    writeFileSync(
      join(TEST_DIR, "settings.json"),
      JSON.stringify({ autoDetectClaudeAccount: false }),
    );
    const d = await getRateLimits();
    assert.equal(d.needsSetup, true);
    assert.equal(d.diagnosis?.code, "auto_detect_off");
  });

  it("INVARIANT: the manual-key path's errors carry a diagnosis too", async () => {
    writeFileSync(
      join(TEST_DIR, "settings.json"),
      JSON.stringify({
        autoDetectClaudeAccount: false,
        claudeSessionKey: "sk-ant-sid01-qa",
      }),
    );
    const cases: Array<[number, string]> = [
      [401, "session_key_rejected"],
      [500, "http_error"],
    ];
    for (const [status, code] of cases) {
      invalidateCache();
      const d = await getRateLimits(async () => ({
        ok: false,
        status,
        json: async () => ({}),
      }));
      assert.ok(d.error, `status ${status} should error`);
      assert.equal(d.diagnosis?.code, code, `status ${status}`);
    }
  });

  it("a hop from one failure to another is NOT logged as recovery", async () => {
    const logs: string[] = [];
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    __setOAuthTokenReaderForTests(() => null);
    await getRateLimits(); // no_login
    __setOAuthTokenReaderForTests(() => token);
    serve({}, 403);
    await getRateLimits(); // usage_forbidden
    assert.ok(!logs.some((l) => /available again/.test(l)));
    assert.equal(warnings.length, 2);
  });

  it("a stale login + a failing saved key surfaces BOTH causes", async () => {
    writeFileSync(
      join(TEST_DIR, "settings.json"),
      JSON.stringify({
        autoDetectClaudeAccount: true,
        claudeSessionKey: "sk-ant-sid01-qa",
      }),
    );
    __setOAuthTokenReaderForTests(() => ({
      ...token,
      expiresAt: Date.now() - 1000,
    }));
    const d = await getRateLimits(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    assert.equal(d.diagnosis?.code, "session_key_rejected");
    assert.match(d.diagnosis?.hint ?? "", /Also: .*expired/);
  });

  // END-TO-END through the real token reader: the keychain's own failure must
  // reach the dashboard answer (the reader records it; the scanner classifies
  // it). macOS-only because the reader only consults `security` on darwin.
  const onDarwin = { skip: process.platform !== "darwin" };
  for (const [label, failure, code] of [
    [
      "denied (exit 51)",
      { code: 51, stderr: "User interaction is not allowed." },
      "keychain_denied",
    ],
    ["timed out", { killed: true, signal: "SIGTERM" }, "keychain_timeout"],
  ] as const) {
    it(
      `a keychain ${label} reaches the answer as ${code}`,
      onDarwin,
      async () => {
        const savedUser = process.env.USER;
        process.env.USER = "diag-test-user";
        __setKeychainExecForTests(async () => {
          throw Object.assign(new Error("security failed"), failure);
        });
        try {
          const d = await getRateLimits();
          assert.equal(d.needsSetup, true);
          assert.equal(d.diagnosis?.code, code);
        } finally {
          __setKeychainExecForTests(null);
          if (savedUser === undefined) delete process.env.USER;
          else process.env.USER = savedUser;
          // The reader keeps its last failure across memo invalidation; a
          // successful read (the env override) clears it — so later tests,
          // which stub the reader, don't inherit this failure.
          process.env.CLAUDE_CODE_OAUTH_TOKEN = "clear-last-failure";
          await getOAuthToken();
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
          invalidateCache();
        }
      },
    );
  }

  it("logs each cause ONCE, then once on recovery", async () => {
    __setOAuthTokenReaderForTests(() => null);
    await getRateLimits();
    await getRateLimits();
    await getRateLimits();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\(no_login\)/);
    const logs: string[] = [];
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    __setOAuthTokenReaderForTests(() => token);
    serve(TEAM_LIMITS_ONLY);
    await getRateLimits();
    assert.ok(logs.some((l) => /available again \(was no_login\)/.test(l)));
    assert.equal(warnings.length, 1);
  });
});
