import { describe, expect, it } from "vitest";
import { isLightBg, recencyBucket, recencyTimestampStyle } from "./recency";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const STATUS_FG = "#9c9c9c";
const FRESH_COLOR = "#d4d4d4"; // a theme's foreground (void page.fg)
const DARK_BG = "#000000"; // void page.bg → dark ramp
const LIGHT_BG = "#fafaf8"; // daylight page.bg → light ramp

describe("recencyBucket — boundaries", () => {
  it("is fresh from 0 up to (but not including) 1h", () => {
    expect(recencyBucket(0)).toBe("fresh");
    expect(recencyBucket(HOUR - 1)).toBe("fresh");
  });

  it("flips to recent at exactly 1h", () => {
    expect(recencyBucket(HOUR)).toBe("recent");
    expect(recencyBucket(DAY - 1)).toBe("recent");
  });

  it("flips to stale at exactly 24h, through just under 7d", () => {
    expect(recencyBucket(DAY)).toBe("stale");
    expect(recencyBucket(WEEK - 1)).toBe("stale");
  });

  it("flips to ancient at exactly 7d and beyond", () => {
    expect(recencyBucket(WEEK)).toBe("ancient");
    expect(recencyBucket(30 * DAY)).toBe("ancient");
  });
});

describe("recencyBucket — degenerate ages fall back to recent (never faded away)", () => {
  it("treats negative (clock skew / future timestamp) as recent", () => {
    expect(recencyBucket(-1)).toBe("recent");
    expect(recencyBucket(-DAY)).toBe("recent");
  });

  it("treats NaN / Infinity (missing timestamp → 'unknown') as recent", () => {
    expect(recencyBucket(Number.NaN)).toBe("recent");
    expect(recencyBucket(Number.POSITIVE_INFINITY)).toBe("recent");
  });
});

describe("isLightBg — classifies theme background by luminance", () => {
  it("dark backgrounds → false", () => {
    expect(isLightBg("#000000")).toBe(false); // void
    expect(isLightBg("#0a0e14")).toBe(false); // midnight
  });

  it("light background → true", () => {
    expect(isLightBg("#fafaf8")).toBe(true); // daylight
  });

  it("unparseable value falls back to dark (false)", () => {
    expect(isLightBg("transparent")).toBe(false);
    expect(isLightBg("")).toBe(false);
  });
});

// recencyTimestampStyle takes (lastActive, now, statusFg, freshColor, bg) and
// guards the TIMESTAMP the same way formatAge does — so these pass a real epoch.
const NOW = 1_700_000_000_000;
const at = (ageMs: number) => NOW - ageMs; // a lastActive `ageMs` in the past

describe("recencyTimestampStyle — dark ramp (72/52)", () => {
  it("fresh: theme foreground, full opacity (NOT statusFg)", () => {
    const style = recencyTimestampStyle(
      at(10 * 60_000),
      NOW,
      STATUS_FG,
      FRESH_COLOR,
      DARK_BG,
    );
    expect(style).toEqual({ color: FRESH_COLOR, opacity: 1 });
    expect(style.color).not.toBe(STATUS_FG);
  });

  it("recent: neutral statusFg, full opacity", () => {
    expect(
      recencyTimestampStyle(at(3 * HOUR), NOW, STATUS_FG, FRESH_COLOR, DARK_BG),
    ).toEqual({ color: STATUS_FG, opacity: 1 });
  });

  it("stale: neutral statusFg, 72% opacity", () => {
    expect(
      recencyTimestampStyle(at(2 * DAY), NOW, STATUS_FG, FRESH_COLOR, DARK_BG),
    ).toEqual({ color: STATUS_FG, opacity: 0.72 });
  });

  it("ancient: neutral statusFg, 52% opacity", () => {
    expect(
      recencyTimestampStyle(at(30 * DAY), NOW, STATUS_FG, FRESH_COLOR, DARK_BG),
    ).toEqual({ color: STATUS_FG, opacity: 0.52 });
  });
});

describe("recencyTimestampStyle — light ramp (86/74, shallower so it stays legible on white)", () => {
  it("stale: 86% opacity on a light background", () => {
    expect(
      recencyTimestampStyle(at(2 * DAY), NOW, "#959da5", "#2e3440", LIGHT_BG)
        .opacity,
    ).toBe(0.86);
  });

  it("ancient: 74% opacity on a light background", () => {
    expect(
      recencyTimestampStyle(at(30 * DAY), NOW, "#959da5", "#2e3440", LIGHT_BG)
        .opacity,
    ).toBe(0.74);
  });

  it("fresh + recent stay full opacity on light too", () => {
    expect(
      recencyTimestampStyle(
        at(10 * 60_000),
        NOW,
        "#959da5",
        "#2e3440",
        LIGHT_BG,
      ).opacity,
    ).toBe(1);
    expect(
      recencyTimestampStyle(at(3 * HOUR), NOW, "#959da5", "#2e3440", LIGHT_BG)
        .opacity,
    ).toBe(1);
  });
});

describe("recencyTimestampStyle — color mapping is theme-driven", () => {
  it("fresh uses the caller's foreground (e.g. daylight's dark fg)", () => {
    expect(
      recencyTimestampStyle(
        at(10 * 60_000),
        NOW,
        "#959da5",
        "#2e3440",
        LIGHT_BG,
      ).color,
    ).toBe("#2e3440");
  });

  it("older buckets keep statusFg, never the fresh color", () => {
    expect(
      recencyTimestampStyle(at(30 * DAY), NOW, "#959da5", "#2e3440", DARK_BG)
        .color,
    ).toBe("#959da5");
  });
});

describe("recencyTimestampStyle — degenerate timestamps stay legible (never faded)", () => {
  // The guard is on the TIMESTAMP, not the derived age: `now - 0` is a huge
  // POSITIVE age that would otherwise bucket ancient and fade the "unknown"
  // label formatAge shows to near-invisibility — the exact failure this feature
  // exists to avoid. Degenerate timestamps render neutral at full opacity in
  // BOTH ramps (recent is 1 on light and dark), agreeing with formatAge.
  it("lastActive === 0 (missing/pre-schema) → full opacity", () => {
    expect(
      recencyTimestampStyle(0, NOW, STATUS_FG, FRESH_COLOR, DARK_BG),
    ).toEqual({ color: STATUS_FG, opacity: 1 });
    expect(
      recencyTimestampStyle(0, NOW, STATUS_FG, FRESH_COLOR, LIGHT_BG).opacity,
    ).toBe(1);
  });

  it("negative lastActive → full opacity", () => {
    expect(
      recencyTimestampStyle(-5, NOW, STATUS_FG, FRESH_COLOR, DARK_BG).opacity,
    ).toBe(1);
  });

  it("future lastActive (clock skew) → full opacity", () => {
    expect(
      recencyTimestampStyle(NOW + 5_000, NOW, STATUS_FG, FRESH_COLOR, DARK_BG)
        .opacity,
    ).toBe(1);
  });

  it("non-finite lastActive → full opacity", () => {
    expect(
      recencyTimestampStyle(Number.NaN, NOW, STATUS_FG, FRESH_COLOR, DARK_BG)
        .opacity,
    ).toBe(1);
    expect(
      recencyTimestampStyle(
        Number.POSITIVE_INFINITY,
        NOW,
        STATUS_FG,
        FRESH_COLOR,
        DARK_BG,
      ).opacity,
    ).toBe(1);
  });
});
