import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActivePane,
  type DvWorkspace,
  pickActiveFallback,
  reconcileDeadWorkspaces,
  useStore,
} from "./store";

// ── Helpers ──────────────────────────────────────────────────────────

const sessionPane = (id: string): ActivePane => ({ type: "session", id });

/** Reset store to a clean state before each test */
function resetStore() {
  useStore.setState({
    activePane: null,
    status: "disconnected",
    sessions: [],
    projects: [],
    sidebarOpen: true,
    permissionMode: "bypass",
    pinnedOrder: [],
    unpinnedOrder: [],
    visiblePaneIds: [],
    dvWorkspaces: {},
    dvPaneWorkspace: {},
  });
}

beforeEach(() => {
  resetStore();
});

// ── switchPane (dockview — the only engine, ADR-047) ─────────────────
// DockviewLayout owns the pane topology; the store just tracks `activePane`.
// Clicking is pure navigation — it opens the pane SOLO and never builds a
// split. Composition is drag-only (exercised end-to-end in Playwright, not here).
describe("switchPane", () => {
  it("opens a pane solo: sets activePane", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    expect(useStore.getState().activePane).toEqual(sessionPane("s1"));
  });

  it("clicking another agent navigates solo", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    useStore.getState().switchPane(sessionPane("s2"));
    expect(useStore.getState().activePane).toEqual(sessionPane("s2"));
  });

  it("openOrgChart routes through switchPane and opens the view solo", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    useStore.getState().openOrgChart();

    expect(useStore.getState().activePane).toEqual({
      type: "orgchart",
      id: "orgchart",
    });
  });

  it("switchPane(null) clears activePane", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    useStore.getState().switchPane(null);
    expect(useStore.getState().activePane).toBeNull();
  });
});

describe("agentIconStyle", () => {
  it("defaults to the provider style", () => {
    expect(useStore.getState().agentIconStyle).toBe("provider");
  });

  it("setAgentIconStyle switches between provider and status", () => {
    useStore.getState().setAgentIconStyle("status");
    expect(useStore.getState().agentIconStyle).toBe("status");
    useStore.getState().setAgentIconStyle("provider");
    expect(useStore.getState().agentIconStyle).toBe("provider");
  });
});

// ── reconcileDeadWorkspaces (cluster C) ──────────────────────────────
// A killed/exited member left in dvWorkspaces[wsId].paneIds makes syncToActive's
// `desired` list permanently mismatch the live panels, forcing a full fromJSON
// teardown+rebuild on EVERY click of a surviving member. Reconcile drops the
// dead id and dissolves ≤1-member groups so `desired` can match again.
describe("reconcileDeadWorkspaces", () => {
  const ws = (paneIds: string[]): DvWorkspace => ({
    paneIds,
    serialized: { grid: {} },
  });

  it("returns null when no member is dead (no needless set)", () => {
    const workspaces = { w1: ws(["a", "b"]) };
    const paneWorkspace = { a: "w1", b: "w1" };
    expect(
      reconcileDeadWorkspaces(workspaces, paneWorkspace, () => false),
    ).toBeNull();
  });

  it("drops a dead member and keeps a 2+-member group intact", () => {
    const workspaces = { w1: ws(["a", "b", "c"]) };
    const paneWorkspace = { a: "w1", b: "w1", c: "w1" };
    const out = reconcileDeadWorkspaces(
      workspaces,
      paneWorkspace,
      (id) => id === "b",
    );
    expect(out).not.toBeNull();
    expect(out?.workspaces.w1.paneIds).toEqual(["a", "c"]);
    expect(out?.paneWorkspace).toEqual({ a: "w1", c: "w1" });
    // serialized carries over (self-heals on the next restore's dead-panel strip)
    expect(out?.workspaces.w1.serialized).toBe(workspaces.w1.serialized);
  });

  it("dissolves a group left with ≤1 live member", () => {
    const workspaces = { w1: ws(["a", "b"]) };
    const paneWorkspace = { a: "w1", b: "w1" };
    const out = reconcileDeadWorkspaces(
      workspaces,
      paneWorkspace,
      (id) => id === "b",
    );
    expect(out?.workspaces).toEqual({}); // dissolved
    expect(out?.paneWorkspace).toEqual({}); // both unbound
  });

  it("does not touch a workspace with no dead members while fixing another", () => {
    const workspaces = { w1: ws(["a", "dead"]), w2: ws(["x", "y"]) };
    const paneWorkspace = { a: "w1", dead: "w1", x: "w2", y: "w2" };
    const out = reconcileDeadWorkspaces(
      workspaces,
      paneWorkspace,
      (id) => id === "dead",
    );
    expect(out?.workspaces.w2).toBe(workspaces.w2); // untouched reference
    expect(out?.workspaces.w1).toBeUndefined(); // dissolved (1 left)
  });
});

// ── pickActiveFallback (cluster D) ───────────────────────────────────
// When the pane you're viewing dies, prefer a live sibling from its group over
// blanking the whole dock to the empty "no agent" screen.
describe("pickActiveFallback", () => {
  const wsMap = { w1: { paneIds: ["a", "b", "c"], serialized: {} } };
  const paneWs = { a: "w1", b: "w1", c: "w1" };

  it("prefers a live sibling from the dead pane's workspace", () => {
    // `a` died; `b` and `c` are live siblings — pick the first live one.
    expect(pickActiveFallback("a", wsMap, paneWs, ["b", "c"])).toEqual({
      type: "session",
      id: "b",
    });
  });

  it("skips dead siblings and picks the next live one", () => {
    // only `c` remains live in the group.
    expect(pickActiveFallback("a", wsMap, paneWs, ["c"])).toEqual({
      type: "session",
      id: "c",
    });
  });

  it("falls back to any live session when the group has no survivors", () => {
    expect(pickActiveFallback("a", wsMap, paneWs, ["z"])).toEqual({
      type: "session",
      id: "z",
    });
  });

  it("returns null only when nothing is live", () => {
    expect(pickActiveFallback("a", wsMap, paneWs, [])).toBeNull();
    // A solo pane (no workspace) with no other live session → null.
    expect(pickActiveFallback("solo", {}, {}, [])).toBeNull();
  });
});
