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

/** Terry's REAL /wham/usage shape on the 2026 "Pro 5x" plan (plan_type
 *  `prolite`), captured read-only 2026-09-12 with numbers zeroed for the
 *  fixture: the headline is WEEKLY-ONLY (no 5h secondary), Spark carries its
 *  own 5h+7d pair, gpt-reserve a 7d only, and the credit balance is a STRING. */
const PROLITE_BODY: CodexUsageRaw = {
  plan_type: "prolite",
  rate_limit: {
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 604_800,
      reset_at: 1_789_793_424,
    },
    secondary_window: null,
  },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18_000,
          reset_at: 1_789_206_624,
        },
        secondary_window: {
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_at: 1_789_793_424,
        },
      },
      normal_model_slug: null,
    },
    {
      limit_name: "gpt-reserve",
      metered_feature: "base_model_inference",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_at: 1_789_793_424,
        },
        secondary_window: null,
      },
      normal_model_slug: "gpt-5.6-luna",
    },
  ],
};

describe("codex usageApi — Pro 5x (prolite) plan shape", () => {
  it("maps the weekly-only headline, both named lanes with CLI labels, and the string balance", () => {
    const mapped = mapCodexUsage(PROLITE_BODY);
    assert.equal(mapped.planType, "prolite");
    assert.equal(mapped.secondary, null);
    assert.equal(mapped.primary?.windowMinutes, 10_080);
    assert.deepEqual(mapped.credits, {
      hasCredits: false,
      unlimited: false,
      balance: 0, // "0" parsed, not dropped to null
    });
    assert.deepEqual(
      mapped.additionalLimits.map((l) => [l.id, l.name, l.description]),
      [
        [
          "codex-codex-bengalfox",
          "GPT-5.3-Codex-Spark",
          "Separate model with its own usage meters",
        ],
        [
          "codex-base-model-inference",
          "Luna Reserve",
          "Fallback lane · GPT-5.6 Luna, used once ordinary usage runs out",
        ],
      ],
    );
    assert.equal(mapped.additionalLimits[0].primary?.windowMinutes, 300);
    assert.equal(mapped.additionalLimits[0].secondary?.windowMinutes, 10_080);
    assert.equal(mapped.additionalLimits[1].secondary, null);
  });

  it("FUTURE-SAFETY: an invented limit_name still renders and counts — never dropped", () => {
    const mapped = mapCodexUsage({
      ...PROLITE_BODY,
      additional_rate_limits: [
        ...(PROLITE_BODY.additional_rate_limits ?? []),
        {
          limit_name: "gpt-9_omega-preview",
          metered_feature: "omega_inference",
          rate_limit: {
            primary_window: {
              used_percent: 42,
              limit_window_seconds: 86_400,
              reset_at: 1_789_293_424,
            },
            secondary_window: null,
          },
        },
      ],
    });
    assert.equal(mapped.additionalLimits.length, 3);
    const novel = mapped.additionalLimits[2];
    assert.equal(novel.id, "codex-omega-inference");
    assert.equal(novel.name, "GPT-9 Omega Preview");
    assert.equal(novel.description, "Additional usage lane");
    assert.equal(novel.primary?.usedPercent, 42);
    assert.equal(novel.primary?.windowMinutes, 1_440);
  });

  it("keeps BOTH lanes when two entries share a metered feature (suffixed id, not dropped)", () => {
    const twin = (PROLITE_BODY.additional_rate_limits ?? [])[1];
    const mapped = mapCodexUsage({
      ...PROLITE_BODY,
      additional_rate_limits: [twin, { ...twin, limit_name: "gpt-reserve-2" }],
    });
    assert.deepEqual(
      mapped.additionalLimits.map((l) => l.id),
      ["codex-base-model-inference", "codex-base-model-inference-2"],
    );
  });

  it("FUTURE-SAFETY: stringified window numbers still render — a lane is never dropped for a quoted number", () => {
    const mapped = mapCodexUsage({
      ...PROLITE_BODY,
      rate_limit: {
        primary_window: {
          used_percent: "34" as never,
          limit_window_seconds: "604800" as never,
          reset_at: "1789793424" as never,
        },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: "gpt-reserve",
          metered_feature: "base_model_inference",
          rate_limit: {
            primary_window: {
              used_percent: "63" as never,
              limit_window_seconds: "604800" as never,
            },
            secondary_window: null,
          },
          normal_model_slug: "gpt-5.6-luna",
        },
      ],
    });
    assert.deepEqual(mapped.primary, {
      usedPercent: 34,
      windowMinutes: 10_080,
      resetsAt: new Date(1_789_793_424_000).toISOString(),
    });
    assert.equal(mapped.additionalLimits.length, 1);
    assert.equal(mapped.additionalLimits[0].name, "Luna Reserve");
    assert.equal(mapped.additionalLimits[0].primary?.usedPercent, 63);
  });

  it("a non-string identity field degrades that lane's label — it never throws the response away", () => {
    const mapped = mapCodexUsage({
      ...PROLITE_BODY,
      additional_rate_limits: [
        {
          limit_name: 5 as never,
          metered_feature: { a: 1 } as never,
          normal_model_slug: 3 as never,
          rate_limit: {
            primary_window: {
              used_percent: 9,
              limit_window_seconds: 18_000,
              reset_at: 1,
            },
            secondary_window: null,
          },
        },
      ],
    });
    assert.equal(mapped.primary?.windowMinutes, 10_080); // headline intact
    assert.equal(mapped.additionalLimits.length, 1);
    assert.equal(mapped.additionalLimits[0].name, "Limit");
    assert.equal(mapped.additionalLimits[0].id, "codex-limit-1");
    assert.equal(mapped.additionalLimits[0].meteredFeature, undefined);
  });

  it("parses numeric-string balances and nulls garbage", () => {
    const at = (balance: unknown) =>
      mapCodexUsage({
        ...PROLITE_BODY,
        credits: {
          has_credits: true,
          unlimited: false,
          balance: balance as never,
        },
      }).credits?.balance;
    assert.equal(at("12.5"), 12.5);
    assert.equal(at(7), 7);
    assert.equal(at("abc"), null);
    assert.equal(at(""), null);
    assert.equal(at(null), null);
  });
});

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
    // A lowercase raw slug is lightly prettified (limitLabels.ts), never dropped.
    assert.equal(mapped.additionalLimits[0].name, "Keeps");
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
