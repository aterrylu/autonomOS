import { describe, expect, it } from "vitest";
import {
  evenPaceAmount,
  formatMoney,
  spendColor,
  spendItemView,
  spendTooltip,
} from "./spend";
import type { SpendLimit } from "./types";

const at = (used: number, limit: number | null): SpendLimit => ({
  used,
  limit,
  percent: limit === null ? null : (used * 100) / limit,
  currency: "USD",
  resetsAt: null,
  source: "extra_usage",
  limitStatus: limit === null ? "none" : "set",
});

const LEVELS = {
  low: at(41, 1000),
  mid: at(620, 1000),
  near: at(930, 1000),
  over: at(1120, 1000),
  none: at(41, null),
};

describe("spendItemView — text (default, R)", () => {
  it("is a quiet gray total below 80%", () => {
    expect(spendItemView(LEVELS.low, "text")).toEqual({
      kind: "total",
      text: "$41",
      color: null,
    });
    expect(spendItemView(LEVELS.mid, "text")).toEqual({
      kind: "total",
      text: "$620",
      color: null,
    });
  });
  it("adds the limit in amber from 80%, red at or over", () => {
    expect(spendItemView(LEVELS.near, "text")).toEqual({
      kind: "total",
      text: "$930 / $1,000",
      color: "#e6b450",
    });
    expect(spendItemView(LEVELS.over, "text")).toEqual({
      kind: "total",
      text: "$1,120 / $1,000",
      color: "#ea6c73",
    });
  });
});

describe("spendItemView — percent", () => {
  it("shows the real percent, >100% when over", () => {
    expect(spendItemView(LEVELS.low, "percent")).toMatchObject({
      kind: "percent",
      text: "4%",
    });
    expect(spendItemView(LEVELS.near, "percent")).toMatchObject({
      text: "93%",
      color: "#e6b450",
    });
    expect(spendItemView(LEVELS.over, "percent")).toMatchObject({
      text: "112%",
      color: "#ea6c73",
    });
  });
});

describe("spendItemView — bar", () => {
  it("fills to the percent; over the limit is a full red bar with the over marker", () => {
    expect(spendItemView(LEVELS.mid, "bar")).toEqual({
      kind: "bar",
      fill: 62,
      color: "#238636",
      over: false,
    });
    expect(spendItemView(LEVELS.over, "bar")).toEqual({
      kind: "bar",
      fill: 100,
      color: "#ea6c73",
      over: true,
    });
  });
});

describe("no limit set — never a fake denominator", () => {
  for (const style of ["text", "percent", "bar"] as const) {
    it(`${style} falls back to the neutral total`, () => {
      expect(spendItemView(LEVELS.none, style)).toEqual({
        kind: "total",
        text: "$41",
        color: null,
      });
    });
  }
  it("the tooltip explains the fallback in % and bar styles only", () => {
    expect(spendTooltip(LEVELS.none, "percent")).toMatch(/no percentage/);
    expect(spendTooltip(LEVELS.none, "bar")).toMatch(/no percentage/);
    expect(spendTooltip(LEVELS.none, "text")).not.toMatch(/no percentage/);
    expect(spendTooltip(LEVELS.none, "text")).toMatch(/No spend limit is set/);
  });
});

describe("spendTooltip — the same facts in every style", () => {
  it("carries spent / limit / %, the reset, and the admin hint near the limit", () => {
    for (const style of ["text", "percent", "bar"] as const) {
      const t = spendTooltip(LEVELS.near, style);
      expect(t).toMatch(/\$930 of your \$1,000 spend limit \(93%\)/);
      expect(t).toMatch(/next billing period/);
      expect(t).toMatch(/ask an admin/);
    }
  });
  it("over the limit says Claude is paused until an admin or the next period", () => {
    expect(spendTooltip(LEVELS.over, "text")).toMatch(
      /paused until an admin raises it or the next billing period/,
    );
  });
  it("rounds DOWN everywhere, so the display never claims more than is true", () => {
    const p796 = at(796, 1000);
    const p996 = at(996, 1000);
    expect(spendItemView(p796, "percent")).toMatchObject({
      text: "79%",
      color: "#238636",
    });
    expect(spendItemView(p796, "text")).toEqual({
      kind: "total",
      text: "$796",
      color: null,
    });
    expect(spendTooltip(p796, "text")).toMatch(/\(79%\)/);
    expect(spendItemView(p996, "percent")).toMatchObject({
      text: "99%",
      color: "#e6b450",
    });
    expect(spendItemView(p996, "bar")).toMatchObject({ over: false });
    expect(spendTooltip(p996, "text")).not.toMatch(/paused/);
    expect(formatMoney(999.6)).toBe("$999");
  });

  it("an unreadable limit is never described as 'no limit set'", () => {
    const u: SpendLimit = { ...LEVELS.none, limitStatus: "unreadable" };
    expect(spendItemView(u, "percent")).toEqual({
      kind: "total",
      text: "$41",
      color: null,
    });
    expect(spendTooltip(u, "percent")).toMatch(/couldn't be read/);
    expect(spendTooltip(u, "percent")).not.toMatch(/No spend limit is set/);
  });

  it("a past reset date (stale snapshot) falls back to 'next billing period' with no pace", () => {
    const now = new Date("2026-10-03T00:00:00Z").getTime();
    const stale = { ...LEVELS.mid, resetsAt: "2026-10-01T00:00:00Z" };
    expect(spendTooltip(stale, "text", now)).toMatch(/next billing period/);
    expect(spendTooltip(stale, "text", now)).not.toMatch(/pace/);
  });

  it("clamps the pace month (a Mar 31 reset starts Feb 28) and prints the date in UTC", () => {
    const now = new Date("2026-03-15T00:00:00Z").getTime();
    const mar31 = { ...LEVELS.mid, resetsAt: "2026-03-31T00:00:00Z" };
    // Feb 28 → Mar 31 is 31 days; Mar 15 is 15 days in.
    expect(evenPaceAmount(mar31, now)).toBeCloseTo((1000 * 15) / 31, 1);
    const oct1 = { ...LEVELS.mid, resetsAt: "2026-10-01T00:00:00Z" };
    expect(
      spendTooltip(oct1, "text", new Date("2026-09-24T00:00:00Z").getTime()),
    ).toMatch(/Resets Oct 1/);
  });

  it("adds pace only when the reset date is known", () => {
    const now = new Date("2026-09-24T00:00:00Z").getTime();
    const dated = { ...LEVELS.mid, resetsAt: "2026-10-01T00:00:00Z" };
    expect(spendTooltip(LEVELS.mid, "text", now)).not.toMatch(/pace/);
    expect(spendTooltip(dated, "text", now)).toMatch(
      /Under pace: even spending would be \$7\d\d by today/,
    );
    expect(evenPaceAmount(dated, now)).toBeCloseTo(766.67, 0);
  });
});

describe("helpers", () => {
  it("formats money: whole units from 10, cents below, unknown currency survives", () => {
    expect(formatMoney(1120)).toBe("$1,120");
    expect(formatMoney(4.13)).toBe("$4.13");
    expect(formatMoney(620, "EUR")).toBe("€620");
    expect(formatMoney(5, "NOT-A-CODE")).toBe("5.00 NOT-A-CODE");
  });
  it("uses amber from 80% and red at 100%", () => {
    expect(spendColor(79.9)).toBe("#238636");
    expect(spendColor(80)).toBe("#e6b450");
    expect(spendColor(100)).toBe("#ea6c73");
  });
});
