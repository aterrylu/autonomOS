import { describe, expect, it } from "vitest";
import { THEMES } from "../store";
import {
  RECENCY_OPACITY_DARK,
  RECENCY_OPACITY_LIGHT,
  type RecencyBucket,
} from "./recency";
import { STATUS_COLORS_DARK, STATUS_COLORS_LIGHT } from "./statusLabelStyle";

/**
 * WCAG contrast of the sidebar's text against the page background, composited
 * the way the browser paints it: a faded span at opacity `a` shows
 * `a·fg + (1−a)·bg`. Terry flagged Daylight text as "so faint": the muted
 * token was 2.63:1 before any fade. These pins keep it fixed.
 *
 * Floors: unfaded text meets AA (4.5:1). Recency-faded text is meant to
 * recede but must stay legible, so it keeps >= 3:1 on the light theme.
 */

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: string, bg: string, opacity = 1): number {
  const f = rgb(fg);
  const b = rgb(bg);
  const eff = f.map((c, i) => opacity * c + (1 - opacity) * b[i]) as [
    number,
    number,
    number,
  ];
  const [hi, lo] = [luminance(eff), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const FADED: RecencyBucket[] = ["stale", "ancient"];

describe("Daylight text contrast (Terry: 'the words look so faint')", () => {
  const { bg, fg, statusFg } = THEMES.daylight.page;

  it("muted text (statusFg) meets WCAG AA unfaded", () => {
    expect(contrast(statusFg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("primary text is comfortably high contrast", () => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(7);
  });

  it("recency-faded timestamps stay legible (>= 3:1) at every faded bucket", () => {
    for (const b of FADED) {
      expect(
        contrast(statusFg, bg, RECENCY_OPACITY_LIGHT[b]),
        `timestamp @ ${b}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("the recency-faded Idle label stays legible (>= 3:1) at every faded bucket", () => {
    for (const b of FADED) {
      expect(
        contrast(STATUS_COLORS_LIGHT.ready, bg, RECENCY_OPACITY_LIGHT[b]),
        `Idle label @ ${b}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("unfaded status labels meet AA", () => {
    for (const [k, c] of Object.entries(STATUS_COLORS_LIGHT)) {
      expect(contrast(c, bg), k).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe.each([
  "midnight",
  "void",
] as const)("%s text contrast (same standard as Daylight)", (t) => {
  const { bg, fg, statusFg } = THEMES[t].page;

  it("muted text (statusFg) meets WCAG AA unfaded", () => {
    expect(contrast(statusFg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("primary text is comfortably high contrast", () => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(7);
  });

  it("recency-faded timestamps stay legible (>= 3:1) at every faded bucket", () => {
    for (const b of FADED) {
      expect(
        contrast(statusFg, bg, RECENCY_OPACITY_DARK[b]),
        `timestamp @ ${b}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("the recency-faded Idle label stays legible (>= 3:1) at every faded bucket", () => {
    for (const b of FADED) {
      expect(
        contrast(STATUS_COLORS_DARK.ready, bg, RECENCY_OPACITY_DARK[b]),
        `Idle label @ ${b}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("unfaded status labels meet AA", () => {
    for (const [k, c] of Object.entries(STATUS_COLORS_DARK)) {
      expect(contrast(c, bg), k).toBeGreaterThanOrEqual(4.5);
    }
  });
});
