// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test/setup-dom";
import { useStore } from "./store";

/**
 * Integration test for the default-view behavior through the REAL Zustand
 * persist middleware (not just the resolveSidebarViewMode unit). It seeds
 * localStorage the way a returning user's browser would have it, calls the
 * store's own rehydrate(), and asserts the resolved view. This is what proves
 * the wiring in merge() — unit tests cover the helper in isolation.
 *
 * Zustand persist (default) stores `{ state, version }` under the configured
 * key ("autonomos").
 */

const KEY = "autonomos";

function seed(state: Record<string, unknown>) {
  localStorage.setItem(KEY, JSON.stringify({ state, version: 0 }));
}

beforeEach(() => {
  localStorage.clear();
  // The store is a singleton; calling rehydrate() again uses the CURRENT state
  // as merge()'s `current`, and resolveSidebarViewMode reads its default from
  // current.sidebarViewMode. Reset to the built defaults so each test models a
  // fresh load (default = "hierarchy"), matching real app startup.
  useStore.setState({
    sidebarViewMode: "hierarchy",
    sidebarViewModeExplicit: false,
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("sidebar view rehydration (persist merge integration)", () => {
  it("upgrades an existing user's auto-persisted flat view to hierarchical", async () => {
    // A returning user whose old default "flat" was auto-saved, but who never
    // explicitly toggled — no sidebarViewModeExplicit flag present.
    seed({ sidebarViewMode: "flat" });
    await useStore.persist.rehydrate();
    expect(useStore.getState().sidebarViewMode).toBe("hierarchy");
    expect(useStore.getState().sidebarViewModeExplicit).toBe(false);
  });

  it("honors an explicitly chosen flat view across rehydration", async () => {
    seed({ sidebarViewMode: "flat", sidebarViewModeExplicit: true });
    await useStore.persist.rehydrate();
    expect(useStore.getState().sidebarViewMode).toBe("flat");
    expect(useStore.getState().sidebarViewModeExplicit).toBe(true);
  });

  it("defaults to hierarchical with no persisted state", async () => {
    await useStore.persist.rehydrate();
    expect(useStore.getState().sidebarViewMode).toBe("hierarchy");
    expect(useStore.getState().sidebarViewModeExplicit).toBe(false);
  });

  it("falls back to hierarchical when the persisted view is corrupted", async () => {
    seed({ sidebarViewMode: "garbage", sidebarViewModeExplicit: true });
    await useStore.persist.rehydrate();
    expect(useStore.getState().sidebarViewMode).toBe("hierarchy");
  });
});
