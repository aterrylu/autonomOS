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
 * The browser-only Permission Mode default is gone: the server's per-runtime
 * defaults replaced it (ADR-115). A returning browser still holds the old
 * `permissionMode` (or the pre-ADR-045 `autonomousMode`) — it must load as
 * nothing, and must not be written back, so it can't come back to steer spawns.
 */
describe("the retired browser-only permission default", () => {
  it("is ignored on load and dropped on the next write", async () => {
    seed({ permissionMode: "bypass", autonomousMode: true });
    await useStore.persist.rehydrate();
    const state = useStore.getState() as unknown as Record<string, unknown>;
    expect(state).not.toHaveProperty("permissionMode");
    expect(state).not.toHaveProperty("setPermissionMode");

    useStore.setState({ sidebarWidth: 301 }); // any persisted change re-writes
    const written = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(written.state).toBeDefined();
    expect(written.state).not.toHaveProperty("permissionMode");
    expect(written.state).not.toHaveProperty("autonomousMode");
  });
});

describe("projects group rehydration", () => {
  it("restores the open Projects group across a reload (#369 bug #8), clamped to one", async () => {
    // partialize writes expandedProjects; merge must read it back or every
    // reload collapses the group (nox). A legacy multi-open map clamps to the
    // accordion's at-most-one invariant.
    seed({
      expandedProjects: { "/repo/a": true, "/repo/b": true, "/repo/c": false },
    });
    await useStore.persist.rehydrate();
    const open = Object.entries(useStore.getState().expandedProjects).filter(
      ([, v]) => v,
    );
    expect(open).toHaveLength(1);
    expect(open[0][0]).toBe("/repo/a");
  });

  it("ignores a corrupted expandedProjects value", async () => {
    useStore.setState({ expandedProjects: {} });
    seed({ expandedProjects: "nope" });
    await useStore.persist.rehydrate();
    expect(useStore.getState().expandedProjects).toEqual({});
  });
});
