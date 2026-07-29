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
    pinnedOrder: [],
    unpinnedOrder: [],
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

describe("flat-view order rehydration (pin/unpin migration)", () => {
  it("migrates a legacy paneOrder into the unpinned section (nothing pre-pinned)", async () => {
    // A returning user from before pinning existed — only the old single list.
    seed({ paneOrder: ["a", "b", "c"] });
    await useStore.persist.rehydrate();
    expect(useStore.getState().unpinnedOrder).toEqual(["a", "b", "c"]);
    expect(useStore.getState().pinnedOrder).toEqual([]);
  });

  it("migrates the even-older sessionOrder when paneOrder is absent", async () => {
    seed({ sessionOrder: ["x", "y"] });
    await useStore.persist.rehydrate();
    expect(useStore.getState().unpinnedOrder).toEqual(["x", "y"]);
    expect(useStore.getState().pinnedOrder).toEqual([]);
  });

  it("restores pinnedOrder + unpinnedOrder when both are present", async () => {
    seed({ pinnedOrder: ["b"], unpinnedOrder: ["a", "c"] });
    await useStore.persist.rehydrate();
    expect(useStore.getState().pinnedOrder).toEqual(["b"]);
    expect(useStore.getState().unpinnedOrder).toEqual(["a", "c"]);
  });

  it("prefers new unpinnedOrder over a stale legacy paneOrder", async () => {
    seed({ unpinnedOrder: ["new"], paneOrder: ["legacy"] });
    await useStore.persist.rehydrate();
    expect(useStore.getState().unpinnedOrder).toEqual(["new"]);
  });
});

/**
 * Permission mode is persisted per-browser, so a returning user's localStorage
 * can hold any spelling that was current when they last touched the dropdown:
 * today's `ask`, the pre-rename `default`, or the pre-ADR-045 `autonomousMode`
 * boolean. All three have to land on a valid mode — an unrecognized value would
 * leave the Create Agent form seeded with something the server rejects.
 */
describe("permission mode rehydration", () => {
  beforeEach(() => {
    useStore.setState({ permissionMode: "ask" });
  });

  it("restores a current spelling unchanged", async () => {
    seed({ permissionMode: "bypass" });
    await useStore.persist.rehydrate();
    expect(useStore.getState().permissionMode).toBe("bypass");
  });

  it("migrates the pre-rename 'default' spelling to 'ask'", async () => {
    // Distinguishing detail: seed a NON-ask starting state, so passing this
    // requires the alias to actually fire. If "default" were dropped as
    // unrecognized, the store would keep "bypass" below rather than move.
    useStore.setState({ permissionMode: "bypass" });
    seed({ permissionMode: "default" });
    await useStore.persist.rehydrate();
    expect(useStore.getState().permissionMode).toBe("ask");
  });

  it("still migrates the legacy autonomousMode boolean (ADR-045)", async () => {
    seed({ autonomousMode: true });
    await useStore.persist.rehydrate();
    expect(useStore.getState().permissionMode).toBe("bypass");
  });

  it("an explicit (aliased) mode wins over the legacy boolean", async () => {
    seed({ permissionMode: "default", autonomousMode: true });
    await useStore.persist.rehydrate();
    expect(useStore.getState().permissionMode).toBe("ask");
  });

  it("ignores an unrecognized mode rather than adopting it", async () => {
    seed({ permissionMode: "yolo" });
    await useStore.persist.rehydrate();
    expect(useStore.getState().permissionMode).toBe("ask");
  });
});
