import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store";

// ── Helpers ──────────────────────────────────────────────────────────

function resetStore() {
  useStore.setState({
    sidebarWidth: 256,
    sidebarOpen: true,
  });
}

// Provide a minimal window stub for the store's window.innerWidth access
const fakeWindow = { innerWidth: 1920 };

beforeEach(() => {
  resetStore();
  vi.stubGlobal("window", fakeWindow);
  fakeWindow.innerWidth = 1920;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── setSidebarWidth ────────────────────────────────────────────────

describe("setSidebarWidth", () => {
  it("should set width to the given value", () => {
    useStore.getState().setSidebarWidth(300);
    expect(useStore.getState().sidebarWidth).toBe(300);
  });

  it("should clamp to minimum (180px)", () => {
    useStore.getState().setSidebarWidth(100);
    expect(useStore.getState().sidebarWidth).toBe(180);
  });

  it("should clamp to exactly minimum at boundary", () => {
    useStore.getState().setSidebarWidth(180);
    expect(useStore.getState().sidebarWidth).toBe(180);
  });

  it("should clamp to maximum (50% of viewport)", () => {
    useStore.getState().setSidebarWidth(2000);
    expect(useStore.getState().sidebarWidth).toBe(960); // 1920 * 0.5
  });

  it("should clamp to exactly maximum at boundary", () => {
    useStore.getState().setSidebarWidth(960);
    expect(useStore.getState().sidebarWidth).toBe(960);
  });

  it("should reject NaN", () => {
    useStore.getState().setSidebarWidth(400);
    useStore.getState().setSidebarWidth(Number.NaN);
    expect(useStore.getState().sidebarWidth).toBe(400);
  });

  it("should reject Infinity", () => {
    useStore.getState().setSidebarWidth(400);
    useStore.getState().setSidebarWidth(Number.POSITIVE_INFINITY);
    expect(useStore.getState().sidebarWidth).toBe(400);
  });

  it("should reject negative Infinity", () => {
    useStore.getState().setSidebarWidth(400);
    useStore.getState().setSidebarWidth(Number.NEGATIVE_INFINITY);
    expect(useStore.getState().sidebarWidth).toBe(400);
  });

  it("should handle zero (clamps to min)", () => {
    useStore.getState().setSidebarWidth(0);
    expect(useStore.getState().sidebarWidth).toBe(180);
  });

  it("should handle negative values (clamps to min)", () => {
    useStore.getState().setSidebarWidth(-500);
    expect(useStore.getState().sidebarWidth).toBe(180);
  });

  it("should adapt max to different viewport widths", () => {
    fakeWindow.innerWidth = 800;
    useStore.getState().setSidebarWidth(600);
    expect(useStore.getState().sidebarWidth).toBe(400); // 800 * 0.5
  });
});

// ── resetSidebarWidth ──────────────────────────────────────────────

describe("resetSidebarWidth", () => {
  it("should reset to default (256px)", () => {
    useStore.getState().setSidebarWidth(400);
    useStore.getState().resetSidebarWidth();
    expect(useStore.getState().sidebarWidth).toBe(256);
  });

  it("should reset from minimum", () => {
    useStore.getState().setSidebarWidth(180);
    useStore.getState().resetSidebarWidth();
    expect(useStore.getState().sidebarWidth).toBe(256);
  });

  it("should reset from maximum", () => {
    useStore.getState().setSidebarWidth(960);
    useStore.getState().resetSidebarWidth();
    expect(useStore.getState().sidebarWidth).toBe(256);
  });
});
