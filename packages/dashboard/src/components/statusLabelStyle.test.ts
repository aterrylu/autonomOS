import { describe, expect, it } from "vitest";
import {
  STATUS_COLORS_DARK,
  STATUS_COLORS_LIGHT,
  statusLabelStyle,
} from "./statusLabelStyle";

const ACTIVE_WORK = [
  "working",
  "tool_running",
  "compacting",
  "orchestrating",
] as const;
const NON_ACTIVE = [
  "ready",
  "idle",
  "needs_input",
  "error",
  "stopped",
  "unknown",
] as const;

describe("statusLabelStyle — dark palette (isLight = false)", () => {
  it("active-work statuses shimmer in the dark slate base", () => {
    for (const s of ACTIVE_WORK) {
      expect(statusLabelStyle(s, false)).toEqual({
        color: STATUS_COLORS_DARK.active,
        shimmer: true,
      });
    }
  });

  it("static statuses take their dark-palette color, no shimmer", () => {
    expect(statusLabelStyle("ready", false)).toEqual({
      color: STATUS_COLORS_DARK.ready,
      shimmer: false,
    });
    expect(statusLabelStyle("idle", false)).toEqual({
      color: STATUS_COLORS_DARK.ready,
      shimmer: false,
    });
    expect(statusLabelStyle("needs_input", false)).toEqual({
      color: STATUS_COLORS_DARK.needsInput,
      shimmer: false,
    });
    expect(statusLabelStyle("error", false)).toEqual({
      color: STATUS_COLORS_DARK.error,
      shimmer: false,
    });
    expect(statusLabelStyle("stopped", false)).toEqual({
      color: STATUS_COLORS_DARK.neutral,
      shimmer: false,
    });
    expect(statusLabelStyle("unknown", false)).toEqual({
      color: STATUS_COLORS_DARK.neutral,
      shimmer: false,
    });
  });
});

describe("statusLabelStyle — light palette (isLight = true) uses darkened, legible variants", () => {
  it("each status takes its light-palette color", () => {
    expect(statusLabelStyle("working", true).color).toBe(
      STATUS_COLORS_LIGHT.active,
    );
    expect(statusLabelStyle("ready", true).color).toBe(
      STATUS_COLORS_LIGHT.ready,
    );
    expect(statusLabelStyle("needs_input", true).color).toBe(
      STATUS_COLORS_LIGHT.needsInput,
    );
    expect(statusLabelStyle("error", true).color).toBe(
      STATUS_COLORS_LIGHT.error,
    );
    expect(statusLabelStyle("stopped", true).color).toBe(
      STATUS_COLORS_LIGHT.neutral,
    );
  });

  it("the light palette is genuinely different (darkened) from the dark one", () => {
    expect(STATUS_COLORS_LIGHT.active).not.toBe(STATUS_COLORS_DARK.active);
    expect(STATUS_COLORS_LIGHT.ready).not.toBe(STATUS_COLORS_DARK.ready);
    expect(STATUS_COLORS_LIGHT.needsInput).not.toBe(
      STATUS_COLORS_DARK.needsInput,
    );
    expect(STATUS_COLORS_LIGHT.error).not.toBe(STATUS_COLORS_DARK.error);
    expect(STATUS_COLORS_LIGHT.neutral).not.toBe(STATUS_COLORS_DARK.neutral);
  });
});

describe("statusLabelStyle — invariants (both palettes)", () => {
  it("ONLY active-work statuses shimmer", () => {
    for (const isLight of [false, true]) {
      for (const s of ACTIVE_WORK)
        expect(statusLabelStyle(s, isLight).shimmer).toBe(true);
      for (const s of NON_ACTIVE)
        expect(statusLabelStyle(s, isLight).shimmer).toBe(false);
    }
  });

  it("no status uses the reserved gold accent (#f5d76e)", () => {
    for (const isLight of [false, true]) {
      for (const s of [...ACTIVE_WORK, ...NON_ACTIVE]) {
        expect(statusLabelStyle(s, isLight).color).not.toBe("#f5d76e");
      }
    }
  });
});

describe("statusLabelStyle — locked spec values", () => {
  it("dark palette matches Terry's approved muted-accent hexes exactly", () => {
    expect(STATUS_COLORS_DARK).toEqual({
      active: "#7e97b3",
      ready: "#7d9a80",
      needsInput: "#eab308",
      error: "#d98a6a",
      neutral: "#a3a3a3",
    });
  });

  it("light palette matches the darkened-for-legibility variants", () => {
    expect(STATUS_COLORS_LIGHT).toEqual({
      active: "#3f5f85",
      ready: "#46714f",
      needsInput: "#8a6900",
      error: "#b0503a",
      neutral: "#6b7178",
    });
  });
});
