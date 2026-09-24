import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

// Isolate every path the scanner reads (settings, Claude Code config, HOME)
// and strip ambient auth env before importing.
const TEST_DIR = join(tmpdir(), `autonomos-test-usage-spend-${randomUUID()}`);
const CLAUDE_DIR = join(TEST_DIR, "claude");
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
process.env.HOME = TEST_DIR;
for (const k of [
  "CLAUDE_SESSION_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]) {
  delete process.env[k];
}
before(() => mkdirSync(CLAUDE_DIR, { recursive: true }));
after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

const {
  mapSpendLimit,
  __setOAuthTokenReaderForTests,
  __setOAuthFetcherForTests,
} = await import("../plugins/claude-usage/oauthUsage.js");
const { getRateLimits, invalidateCache, __resetDiagnosisLogForTests } =
  await import("../plugins/claude-usage/scanner.js");
const { normalizeClaudeUsage, evaluateCap } = await import("../usageQueue.js");
type OAuthUsageRaw = Parameters<typeof mapSpendLimit>[0];
type RateLimitData = Awaited<ReturnType<typeof getRateLimits>>;

/** codexbar's Enterprise fixture (ClaudeWebEnterpriseUsageTests): no rolling
 *  window, a monthly cap in CENTS. Third-party fixture, not our own capture. */
const ENTERPRISE: OAuthUsageRaw = {
  five_hour: null,
  seven_day: null,
  extra_usage: { monthly_limit: 100000, used_credits: 4132 },
};

/** codexbar's Enterprise OAuth fixture (ClaudeOAuthTests), is_enabled set. */
const ENTERPRISE_OAUTH: OAuthUsageRaw = {
  five_hour: null,
  seven_day: null,
  extra_usage: {
    is_enabled: true,
    monthly_limit: 2000,
    used_credits: 763,
    utilization: 38.15,
  },
};

/** Terry's real Max payload (home, 2026-09-24): credits off, spend disabled. */
const MAX_HOME: OAuthUsageRaw = {
  five_hour: { utilization: 13, resets_at: "2026-09-24T10:49:59Z" },
  seven_day: { utilization: 4, resets_at: "2026-09-30T21:59:59Z" },
  extra_usage: { is_enabled: false, utilization: null },
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: null,
    percent: 0,
    enabled: false,
  },
};

describe("mapSpendLimit — spend-metered shapes", () => {
  it("reads the Enterprise web fixture in cents: $41.32 of $1,000 (session-key path)", () => {
    const s = mapSpendLimit(ENTERPRISE, { web: true });
    assert.ok(s);
    assert.equal(s.used, 41.32);
    assert.equal(s.limit, 1000);
    assert.ok(Math.abs((s.percent ?? 0) - 4.132) < 1e-9);
    assert.equal(s.currency, "USD");
    assert.equal(s.resetsAt, null);
    assert.equal(s.source, "extra_usage");
    assert.equal(s.limitStatus, "set");
  });

  it("the OAuth path requires is_enabled: true (the web body omits it)", () => {
    assert.equal(mapSpendLimit(ENTERPRISE), null);
  });

  it("reads the Enterprise OAuth fixture: $7.63 of $20", () => {
    const s = mapSpendLimit(ENTERPRISE_OAUTH);
    assert.equal(s?.used, 7.63);
    assert.equal(s?.limit, 20);
  });

  it("no limit set → limit and percent are null, never a made-up denominator", () => {
    const s = mapSpendLimit({
      extra_usage: { is_enabled: true, used_credits: 4100 },
    });
    assert.equal(s?.used, 41);
    assert.equal(s?.limit, null);
    assert.equal(s?.percent, null);
    assert.equal(s?.limitStatus, "none");
  });

  it("a present-but-unusable limit is 'unreadable', never reported as 'none'", () => {
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const monthly_limit of [0, -500, "abc"]) {
        const s = mapSpendLimit({
          extra_usage: {
            is_enabled: true,
            used_credits: 100,
            monthly_limit: monthly_limit as never,
          },
        });
        assert.equal(
          s?.limitStatus,
          "unreadable",
          `monthly_limit ${monthly_limit}`,
        );
        assert.equal(s?.percent, null);
      }
      const mixed = mapSpendLimit({
        spend: {
          enabled: true,
          used: { amount_minor: 90000, currency: "EUR", exponent: 2 },
          limit: { amount_minor: 1000, currency: "JPY", exponent: 0 },
        },
      });
      assert.equal(mixed?.limitStatus, "unreadable", "currencies differ");
    } finally {
      console.warn = quiet;
    }
  });

  it("prefers the source with a readable limit", () => {
    const s = mapSpendLimit({
      extra_usage: { is_enabled: true, used_credits: 0 },
      spend: {
        enabled: true,
        used: { amount_minor: 90000, currency: "USD", exponent: 2 },
        limit: { amount_minor: 100000, currency: "USD", exponent: 2 },
      },
    });
    assert.equal(s?.source, "spend");
    assert.equal(s?.used, 900);
    assert.equal(s?.percent, 90);
  });

  it("rejects wild exponents and negative amounts instead of inventing money", () => {
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const exponent of [-2, 2.5, 400]) {
        assert.equal(
          mapSpendLimit({
            spend: { enabled: true, used: { amount_minor: 500, exponent } },
          }),
          null,
          `exponent ${exponent}`,
        );
      }
      assert.equal(
        mapSpendLimit({
          extra_usage: { is_enabled: true, used_credits: -500 },
        }),
        null,
      );
    } finally {
      console.warn = quiet;
    }
  });

  it("over the limit keeps the real percent (>100)", () => {
    const s = mapSpendLimit({
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100000,
        used_credits: 112000,
      },
    });
    assert.equal(s?.percent, 112);
  });

  it("Terry's Max shape (credits off, spend disabled) has no spend meter", () => {
    assert.equal(mapSpendLimit(MAX_HOME), null);
  });

  it("INFERRED spend block: money objects with an exponent; a bare-number limit is not trusted", () => {
    const s = mapSpendLimit({
      spend: {
        enabled: true,
        used: { amount_minor: 62000, currency: "EUR", exponent: 2 },
        limit: { amount_minor: 100000, currency: "EUR", exponent: 2 },
        resets_at: "2026-10-01T00:00:00Z",
      },
    });
    assert.equal(s?.used, 620);
    assert.equal(s?.limit, 1000);
    assert.equal(s?.currency, "EUR");
    assert.equal(s?.resetsAt, "2026-10-01T00:00:00Z");
    assert.equal(s?.source, "spend");
    const quiet = console.warn;
    console.warn = () => {};
    const bare = mapSpendLimit({
      spend: { enabled: true, used: { amount_minor: 100 }, limit: 5000 },
    });
    console.warn = quiet;
    assert.equal(bare?.limit, null);
    assert.equal(bare?.limitStatus, "unreadable");
  });
});

describe("getRateLimits — spend meter only for spend-metered accounts", () => {
  const token = {
    accessToken: `tok-${randomUUID()}`,
    expiresAt: Date.now() + 3_600_000,
    source: "keychain" as const,
    subscriptionType: "enterprise",
  };
  const quiet = { warn: console.warn, log: console.log };
  beforeEach(() => {
    invalidateCache();
    __resetDiagnosisLogForTests();
    console.warn = () => {};
    console.log = () => {};
    __setOAuthTokenReaderForTests(() => token);
  });
  afterEach(() => {
    console.warn = quiet.warn;
    console.log = quiet.log;
    __setOAuthTokenReaderForTests(null);
    __setOAuthFetcherForTests(null);
    invalidateCache();
  });
  const serve = (body: OAuthUsageRaw) =>
    __setOAuthFetcherForTests(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    }));

  it("an Enterprise answer carries spendLimit and NO 'no windows' diagnosis", async () => {
    serve(ENTERPRISE_OAUTH);
    const d = await getRateLimits();
    assert.equal(d.spendLimit?.limit, 20);
    assert.equal(d.diagnosis, undefined);
    assert.equal(d.error, undefined);
  });

  it("Team with credits (windows present) gets NO spend meter — its bar stays 5h/7d", async () => {
    serve({
      five_hour: { utilization: 38, resets_at: "x" },
      seven_day: { utilization: 61, resets_at: "y" },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1200,
      },
    });
    const d = await getRateLimits();
    assert.equal(d.spendLimit, undefined);
    assert.equal(d.fiveHour?.utilization, 38);
    assert.equal(
      d.extraUsage?.usedCredits,
      1200,
      "credits stay available to the panel",
    );
  });

  it("a Pro/Max login with no windows keeps the #387 diagnosis, not a spend meter", async () => {
    __setOAuthTokenReaderForTests(() => ({
      ...token,
      subscriptionType: "max",
    }));
    serve({ ...ENTERPRISE_OAUTH });
    const d = await getRateLimits();
    assert.equal(d.spendLimit, undefined);
    assert.equal(d.diagnosis?.code, "no_rolling_limits");
  });

  it("a spend-metered account on a pasted session key gets its spend meter too", async () => {
    writeFileSync(
      join(TEST_DIR, "settings.json"),
      JSON.stringify({
        autoDetectClaudeAccount: false,
        claudeSessionKey: "sk-ant-sid01-qa",
      }),
    );
    try {
      const d = await getRateLimits(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.includes("/bootstrap")
            ? {
                account: {
                  memberships: [{ organization: { uuid: "org-qa-0001" } }],
                },
              }
            : ENTERPRISE,
      }));
      assert.equal(d.spendLimit?.used, 41.32);
      assert.equal(d.spendLimit?.limit, 1000);
      assert.equal(d.diagnosis, undefined);
    } finally {
      rmSync(join(TEST_DIR, "settings.json"), { force: true });
    }
  });

  it("Terry's Max payload is unchanged: windows, no spend meter", async () => {
    serve(MAX_HOME);
    const d = await getRateLimits();
    assert.equal(d.spendLimit, undefined);
    assert.equal(d.fiveHour?.utilization, 13);
  });
});

describe("HARD RULE — spend never drives the usage queue", () => {
  const base: RateLimitData = {
    fiveHour: null,
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    account: {},
    fetchedAt: new Date().toISOString(),
  };
  const overSpend = {
    used: 1120,
    limit: 1000,
    percent: 112,
    currency: "USD",
    resetsAt: null,
    source: "extra_usage" as const,
    limitStatus: "set" as const,
  };

  it("a spend-only account over its limit gives the queue no window and no cap", () => {
    const q = normalizeClaudeUsage({ ...base, spendLimit: overSpend });
    assert.deepEqual(q.windows, []);
    assert.equal(evaluateCap(q).capped, false);
  });

  it("spend over the limit never caps an account whose windows have room", () => {
    const withWindows: RateLimitData = {
      ...base,
      fiveHour: { utilization: 40, resetsAt: "2026-09-24T12:00:00Z" },
      sevenDay: { utilization: 50, resetsAt: "2026-09-29T00:00:00Z" },
    };
    const q = normalizeClaudeUsage({ ...withWindows, spendLimit: overSpend });
    assert.deepEqual(
      q,
      normalizeClaudeUsage(withWindows),
      "spend changes nothing the queue sees",
    );
    assert.equal(evaluateCap(q).capped, false);
  });
});
