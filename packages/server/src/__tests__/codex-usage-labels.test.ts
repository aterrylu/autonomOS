import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  limitDescription,
  limitDisplayName,
  limitId,
  prettifyLimitName,
} from "../plugins/codex-usage/limitLabels.js";

/**
 * Display names for `additional_rate_limits` lanes. The contract under test
 * (Terry, 2026-09-12): KNOWN names get the Codex CLI's wording; an UNKNOWN
 * name the API sends tomorrow still renders — prettified, with a generic
 * explainer — and is never dropped.
 */
describe("codex limitLabels — known lanes match the Codex CLI", () => {
  it("relabels gpt-reserve to Luna Reserve and names its fallback model", () => {
    const reserve = {
      limitName: "gpt-reserve",
      meteredFeature: "base_model_inference",
      normalModelSlug: "gpt-5.6-luna",
    };
    assert.equal(limitDisplayName(reserve), "Luna Reserve");
    assert.equal(
      limitDescription(reserve),
      "Fallback lane · GPT-5.6 Luna, used once ordinary usage runs out",
    );
    assert.equal(limitId(reserve), "codex-base-model-inference");
  });

  it("keeps Spark under its model name, as `codex /status` does", () => {
    const spark = {
      limitName: "GPT-5.3-Codex-Spark",
      meteredFeature: "codex_bengalfox",
      normalModelSlug: null,
    };
    assert.equal(limitDisplayName(spark), "GPT-5.3-Codex-Spark");
    assert.equal(
      limitDescription(spark),
      "Separate model with its own usage meters",
    );
    assert.equal(limitId(spark), "codex-codex-bengalfox");
  });

  it("is case-insensitive on the reserve id and survives a missing model slug", () => {
    const reserve = { limitName: " GPT-Reserve ", meteredFeature: undefined };
    assert.equal(limitDisplayName(reserve), "Luna Reserve");
    assert.match(limitDescription(reserve), /the reserve model/);
  });
});

describe("codex limitLabels — unknown lanes render gracefully", () => {
  it("prettifies an invented machine slug and gives it the generic explainer", () => {
    const novel = { limitName: "gpt-7_turbo-preview", meteredFeature: "x_y" };
    assert.equal(limitDisplayName(novel), "GPT-7 Turbo Preview");
    assert.equal(limitDescription(novel), "Additional usage lane");
    assert.equal(limitId(novel), "codex-x-y");
  });

  it("matches Spark as a token, not a substring", () => {
    assert.equal(
      limitDescription({ limitName: "sparkle_engine", meteredFeature: "x" }),
      "Additional usage lane",
    );
    assert.equal(
      limitDescription({ limitName: "codex_spark", meteredFeature: "y" }),
      "Separate model with its own usage meters",
    );
  });

  it("shows an author-cased name verbatim", () => {
    assert.equal(prettifyLimitName("Codex Spark 5-hour"), "Codex Spark 5-hour");
    assert.equal(
      prettifyLimitName("GPT-5.3-Codex-Spark"),
      "GPT-5.3-Codex-Spark",
    );
  });

  it("falls back to the metered feature, then to a generic label", () => {
    assert.equal(
      limitDisplayName({ limitName: null, meteredFeature: "code_review" }),
      "Code Review",
    );
    assert.equal(
      limitDisplayName({ limitName: "", meteredFeature: "  " }),
      "Limit",
    );
    assert.equal(limitId({ limitName: "", meteredFeature: "" }), undefined);
  });
});
