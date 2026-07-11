import { describe, expect, it } from "vitest";
import { windowLabel, windowTitle } from "./utils";

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
