import { describe, expect, it } from "vitest";
import { formatPlan, windowLabel, windowTitle } from "./utils";

describe("codex-usage windowLabel (dynamic, plan-agnostic)", () => {
  it("labels day-multiples as days", () => {
    expect(windowLabel(43_200)).toBe("30d"); // free-plan primary
    expect(windowLabel(10_080)).toBe("7d"); // weekly
    expect(windowLabel(1_440)).toBe("1d");
  });

  it("labels hour-multiples as hours", () => {
    expect(windowLabel(300)).toBe("5h"); // 5-hour session window
    expect(windowLabel(60)).toBe("1h");
  });

  it("falls back to minutes for odd spans, and empty for none", () => {
    expect(windowLabel(90)).toBe("90m");
    expect(windowLabel(0)).toBe("");
    expect(windowLabel(-5)).toBe("");
  });
});

describe("codex-usage windowTitle (derived from length, not field name)", () => {
  it("names windows by their own duration so labels can't contradict the span", () => {
    expect(windowTitle(300)).toBe("Session"); // 5h
    expect(windowTitle(10_080)).toBe("Weekly"); // 7d
    expect(windowTitle(43_200)).toBe("Monthly"); // 30d — Terry's free plan
    expect(windowTitle(1_440)).toBe("Daily");
    expect(windowTitle(0)).toBe("Usage");
  });
});

describe("codex-usage formatPlan (known marketing names, unknown ids never hidden)", () => {
  it("maps the Pro tiers to their marketing names, as codexbar does", () => {
    expect(formatPlan("prolite")).toBe("Pro 5x"); // Terry's $100 plan
    expect(formatPlan("pro_lite")).toBe("Pro 5x");
    expect(formatPlan("PRO")).toBe("Pro 20x");
  });

  it("FUTURE-SAFETY: renders an unknown plan id word-split and capitalized", () => {
    expect(formatPlan("free_workspace")).toBe("Free Workspace");
    expect(formatPlan("k12")).toBe("K12");
    expect(formatPlan("ultra-max_2027")).toBe("Ultra Max 2027");
    expect(formatPlan("free")).toBe("Free");
  });

  it("never returns a prototype member for an adversarial plan id", () => {
    expect(formatPlan("constructor")).toBe("Constructor");
    expect(formatPlan("__proto__")).toBe("Proto"); // word-split, not the prototype
    expect(typeof formatPlan("toString")).toBe("string");
  });

  it("returns null when there is no plan", () => {
    expect(formatPlan(null)).toBeNull();
    expect(formatPlan("  ")).toBeNull();
    expect(formatPlan(undefined)).toBeNull();
  });
});
