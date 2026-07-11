import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CodexUsageFetcher,
  type CodexUsageRaw,
  fetchCodexUsage,
  mapCodexUsage,
  mapWindow,
  usageUrl,
} from "../plugins/codex-usage/usageApi.js";

/** A realistic paid-plan /wham/usage body: both windows + credits + a per-model
 *  additional limit (Codex Spark). */
const PAID_BODY: CodexUsageRaw = {
  plan_type: "pro",
  rate_limit: {
    secondary_window: {
      used_percent: 12,
      reset_at: 1_784_531_445,
      limit_window_seconds: 18_000, // 5h
    },
    primary_window: {
      used_percent: 71,
      reset_at: 1_784_600_000,
      limit_window_seconds: 604_800, // 7d
    },
  },
  credits: { has_credits: true, unlimited: false, balance: 42 },
  additional_rate_limits: [
    {
      limit_name: "Codex Spark 5-hour",
      metered_feature: "codex-spark",
      rate_limit: {
        secondary_window: {
          used_percent: 3,
          reset_at: 1_784_531_445,
          limit_window_seconds: 18_000,
        },
        primary_window: null,
      },
    },
  ],
};

describe("codex usageApi — mapCodexUsage (pure mapper)", () => {
  it("maps windows, credits, plan, and per-model additional limits", () => {
    const mapped = mapCodexUsage(PAID_BODY);
    assert.equal(mapped.planType, "pro");
    assert.deepEqual(mapped.secondary, {
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: new Date(1_784_531_445_000).toISOString(),
    });
    assert.equal(mapped.primary?.windowMinutes, 10_080); // 7d
    assert.deepEqual(mapped.credits, {
      hasCredits: true,
      unlimited: false,
      balance: 42,
    });
    assert.equal(mapped.additionalLimits.length, 1);
    assert.equal(mapped.additionalLimits[0].name, "Codex Spark 5-hour");
    assert.equal(mapped.additionalLimits[0].secondary?.usedPercent, 3);
    assert.equal(mapped.additionalLimits[0].primary, null);
  });

  it("handles the free-plan shape: only primary, no secondary/credits", () => {
    const mapped = mapCodexUsage({
      plan_type: "free",
      rate_limit: {
        primary_window: {
          used_percent: 71,
          reset_at: 1_784_531_445,
          limit_window_seconds: 2_592_000, // 30d
        },
        secondary_window: null,
      },
      credits: null,
      additional_rate_limits: null,
    });
    assert.equal(mapped.secondary, null);
    assert.equal(mapped.primary?.windowMinutes, 43_200); // 30d
    assert.equal(mapped.credits, null);
    assert.deepEqual(mapped.additionalLimits, []);
  });

  it("mapWindow nulls a window with no used_percent", () => {
    assert.equal(mapWindow({ reset_at: 1 }), null);
    assert.equal(mapWindow(null), null);
    assert.equal(mapWindow(undefined), null);
  });

  it("drops a malformed additional-limit entry without discarding siblings", () => {
    const mapped = mapCodexUsage({
      additional_rate_limits: [
        // no windows at all → dropped
        { limit_name: "empty", rate_limit: { primary_window: null } },
        // valid → kept
        {
          limit_name: "keeps",
          rate_limit: {
            primary_window: {
              used_percent: 5,
              reset_at: 1,
              limit_window_seconds: 60,
            },
          },
        },
      ],
    });
    assert.equal(mapped.additionalLimits.length, 1);
    assert.equal(mapped.additionalLimits[0].name, "keeps");
  });
});

describe("codex usageApi — fetchCodexUsage", () => {
  const okFetcher =
    (body: CodexUsageRaw): CodexUsageFetcher =>
    async () => ({ ok: true, status: 200, json: async () => body });

  it("sends Bearer + ChatGPT-Account-Id and returns ok data", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetcher: CodexUsageFetcher = async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return { ok: true, status: 200, json: async () => PAID_BODY };
    };
    const res = await fetchCodexUsage(
      "tok-abc",
      "acct-123",
      "https://chatgpt.com/backend-api",
      fetcher,
    );
    assert.equal(res.status, "ok");
    assert.equal(seenUrl, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(seenHeaders.Authorization, "Bearer tok-abc");
    assert.equal(seenHeaders["ChatGPT-Account-Id"], "acct-123");
  });

  it("categorizes 401/403 → unauthorized, 429 → rate_limited, 500 → unavailable", async () => {
    const status =
      (code: number): CodexUsageFetcher =>
      async () => ({
        ok: code < 400,
        status: code,
        json: async () => ({}),
      });
    assert.equal(
      (await fetchCodexUsage("t", undefined, "https://x", status(401))).status,
      "unauthorized",
    );
    assert.equal(
      (await fetchCodexUsage("t", undefined, "https://x", status(403))).status,
      "unauthorized",
    );
    assert.equal(
      (await fetchCodexUsage("t", undefined, "https://x", status(429))).status,
      "rate_limited",
    );
    assert.equal(
      (await fetchCodexUsage("t", undefined, "https://x", status(500))).status,
      "unavailable",
    );
  });

  it("honors a config.toml base-url override in the request URL", async () => {
    let seenUrl = "";
    const fetcher: CodexUsageFetcher = async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await fetchCodexUsage(
      "t",
      undefined,
      "https://proxy.acme/backend-api",
      fetcher,
    );
    assert.equal(seenUrl, "https://proxy.acme/backend-api/wham/usage");
  });

  // ── The ADR-048 read-only contract ────────────────────────────────────────
  // This plugin must NEVER mint/rotate a token: no POST, and never a call to
  // OpenAI's token endpoint. A fetcher that fails the test on either guards the
  // invariant so a future refactor can't "helpfully" add a refresh.
  it("READ-ONLY CONTRACT: only ever issues GET to the usage endpoint", async () => {
    const guard: CodexUsageFetcher = async (url, init) => {
      assert.equal(init.method, "GET", `expected GET, got ${init.method}`);
      assert.ok(
        !url.includes("auth.openai.com") && !url.includes("/oauth/token"),
        `must never touch the token endpoint (got ${url})`,
      );
      assert.ok(url.endsWith("/wham/usage"), `unexpected URL ${url}`);
      return { ok: true, status: 200, json: async () => PAID_BODY };
    };
    const res = await fetchCodexUsage(
      "tok",
      "acct",
      "https://chatgpt.com/backend-api",
      guard,
    );
    assert.equal(res.status, "ok");
  });

  it("usageUrl trims a trailing slash on the base", () => {
    assert.equal(
      usageUrl("https://chatgpt.com/backend-api/"),
      "https://chatgpt.com/backend-api/wham/usage",
    );
  });
});
