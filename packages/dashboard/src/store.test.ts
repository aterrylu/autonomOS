import { beforeEach, describe, expect, it } from "vitest";
import { allPanes, findLeafByPaneId, makeRootLeaf } from "./layout/layoutTree";
import {
  type ActivePane,
  getGroupForPane,
  type PaneGroup,
  useStore,
} from "./store";

// ── Helpers ──────────────────────────────────────────────────────────

const sessionPane = (id: string): ActivePane => ({ type: "session", id });

/** Reset store to a clean state before each test */
function resetStore() {
  const root = makeRootLeaf(null);
  useStore.setState({
    activePane: null,
    status: "disconnected",
    sessions: [],
    projects: [],
    sidebarOpen: true,
    autonomousMode: true,
    paneOrder: [],
    previewPanes: [],
    groups: {},
    activeGroupId: null,
    layout: root,
    focusedLeafId: root.id,
  });
}

/** Set up a single-pane view with one session */
function setupSinglePane(sessionId: string) {
  const pane = sessionPane(sessionId);
  useStore.getState().switchPane(pane);
  return { pane, state: useStore.getState() };
}

/** Set up a split view with two sessions (creates a group) */
function setupSplitView(id1: string, id2: string) {
  const pane1 = sessionPane(id1);
  const pane2 = sessionPane(id2);

  // Start with pane1
  useStore.getState().switchPane(pane1);
  const { focusedLeafId } = useStore.getState();

  // Split to add pane2
  useStore.getState().splitLeafWithPane(focusedLeafId, "horizontal", "second", pane2);

  return {
    pane1,
    pane2,
    state: useStore.getState(),
  };
}

beforeEach(() => {
  resetStore();
});

// ── switchPane ───────────────────────────────────────────────────────

describe("switchPane", () => {
  it("Case 1: focuses pane within active group without changing layout", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const layoutBefore = useStore.getState().layout;

    // pane2 is focused after split. Switch to pane1 (same group).
    useStore.getState().switchPane(pane1);

    const state = useStore.getState();
    expect(state.activePane).toEqual(pane1);
    // Layout should be the SAME object reference (no tree rebuild)
    expect(state.layout).toBe(layoutBefore);
    // Group should still be active
    expect(state.activeGroupId).not.toBeNull();
  });

  it("Case 2: saves group snapshot when navigating away", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const { activeGroupId, layout } = useStore.getState();

    // Navigate to an ungrouped pane
    const pane3 = sessionPane("s3");
    useStore.getState().switchPane(pane3);

    const state = useStore.getState();
    // Active group should be null now
    expect(state.activeGroupId).toBeNull();
    // But the group should still exist with the saved layout
    expect(state.groups[activeGroupId!]).toBeDefined();
    expect(state.groups[activeGroupId!].savedLayout).toBe(layout);
  });

  it("Case 3: restores group layout when clicking a grouped session", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const { activeGroupId } = useStore.getState();

    // Navigate away
    useStore.getState().switchPane(sessionPane("s3"));
    expect(useStore.getState().activeGroupId).toBeNull();

    // Click pane1 (in the group) — should restore split layout
    useStore.getState().switchPane(pane1);

    const state = useStore.getState();
    expect(state.activeGroupId).toBe(activeGroupId);
    expect(state.activePane).toEqual(pane1);
    // Layout should have both panes
    const panes = allPanes(state.layout);
    expect(panes.map((p) => p.id).sort()).toEqual(["s1", "s2"]);
  });

  it("Case 4: creates single-leaf root for ungrouped pane", () => {
    setupSinglePane("s1");

    useStore.getState().switchPane(sessionPane("s2"));

    const state = useStore.getState();
    expect(state.activePane).toEqual(sessionPane("s2"));
    expect(state.layout.kind).toBe("leaf");
    expect(state.activeGroupId).toBeNull();
  });

  it("clears activePane when called with null", () => {
    setupSinglePane("s1");
    useStore.getState().switchPane(null);
    expect(useStore.getState().activePane).toBeNull();
  });

  it("cleans stale memberPaneIds when pane not in layout", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const { activeGroupId, groups } = useStore.getState();

    // Manually corrupt: add a stale pane to memberPaneIds
    useStore.setState({
      groups: {
        ...groups,
        [activeGroupId!]: {
          ...groups[activeGroupId!],
          memberPaneIds: [...groups[activeGroupId!].memberPaneIds, "stale-pane"],
        },
      },
    });

    // Try to switch to the stale pane — should clean it up and fall through
    useStore.getState().switchPane(sessionPane("stale-pane"));

    const state = useStore.getState();
    // Stale pane should be removed from memberPaneIds
    const group = state.groups[activeGroupId!];
    if (group) {
      expect(group.memberPaneIds).not.toContain("stale-pane");
    }
  });
});

// ── splitLeafWithPane ────────────────────────────────────────────────

describe("splitLeafWithPane", () => {
  it("creates a group on first split", () => {
    setupSinglePane("s1");
    const { focusedLeafId } = useStore.getState();

    useStore.getState().splitLeafWithPane(
      focusedLeafId, "horizontal", "second", sessionPane("s2"),
    );

    const state = useStore.getState();
    expect(state.activeGroupId).not.toBeNull();
    const group = state.groups[state.activeGroupId!];
    expect(group.memberPaneIds).toContain("s1");
    expect(group.memberPaneIds).toContain("s2");
  });

  it("extends existing group on subsequent splits", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const { activeGroupId, focusedLeafId } = useStore.getState();

    useStore.getState().splitLeafWithPane(
      focusedLeafId, "vertical", "second", sessionPane("s3"),
    );

    const state = useStore.getState();
    // Same group, now with 3 members
    expect(state.activeGroupId).toBe(activeGroupId);
    const group = state.groups[activeGroupId!];
    expect(group.memberPaneIds).toContain("s3");
    expect(group.memberPaneIds).toHaveLength(3);
  });

  it("does not create a group when pane is null", () => {
    setupSinglePane("s1");
    const { focusedLeafId } = useStore.getState();

    useStore.getState().splitLeafWithPane(
      focusedLeafId, "horizontal", "second", null,
    );

    const state = useStore.getState();
    expect(state.activeGroupId).toBeNull();
    expect(Object.keys(state.groups)).toHaveLength(0);
  });

  it("assigns a color to the new group", () => {
    setupSinglePane("s1");
    const { focusedLeafId } = useStore.getState();

    useStore.getState().splitLeafWithPane(
      focusedLeafId, "horizontal", "second", sessionPane("s2"),
    );

    const state = useStore.getState();
    const group = state.groups[state.activeGroupId!];
    expect(group.color).toBeTruthy();
    expect(group.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// ── movePaneToLeaf ───────────────────────────────────────────────────

describe("movePaneToLeaf", () => {
  it("self-drop center: no-op", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const stateBefore = useStore.getState();
    const leaf1 = findLeafByPaneId(stateBefore.layout, "s1")!;

    useStore.getState().movePaneToLeaf("s1", leaf1.id, "center");

    // State should be unchanged
    const stateAfter = useStore.getState();
    expect(allPanes(stateAfter.layout).map((p) => p.id).sort())
      .toEqual(["s1", "s2"]);
  });

  it("moves pane to other leaf (center): collapses to single leaf", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const state = useStore.getState();
    const leaf2 = findLeafByPaneId(state.layout, "s2")!;

    // Move s1 to leaf2 center → replaces s2, removes s1's old leaf
    useStore.getState().movePaneToLeaf("s1", leaf2.id, "center");

    const after = useStore.getState();
    // Should collapse to single leaf with s1
    expect(after.layout.kind).toBe("leaf");
    expect(after.activePane).toEqual(sessionPane("s1"));
  });

  it("moves pane to directional zone: creates new split", () => {
    // Set up a 3-pane layout
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const state1 = useStore.getState();

    // Split again to add s3
    const leaf2 = findLeafByPaneId(state1.layout, "s2")!;
    useStore.getState().splitLeafWithPane(
      leaf2.id, "vertical", "second", sessionPane("s3"),
    );

    const state2 = useStore.getState();
    const leaf1 = findLeafByPaneId(state2.layout, "s1")!;
    const leaf3 = findLeafByPaneId(state2.layout, "s3")!;

    // Move s1 to east of s3
    useStore.getState().movePaneToLeaf("s1", leaf3.id, "east");

    const after = useStore.getState();
    const paneIds = allPanes(after.layout).map((p) => p.id).sort();
    expect(paneIds).toEqual(["s1", "s2", "s3"]);
  });

  it("no-op when pane not in layout", () => {
    setupSplitView("s1", "s2");
    const { layout } = useStore.getState();
    const leaf1 = findLeafByPaneId(layout, "s1")!;

    // Try to move a non-existent pane
    useStore.getState().movePaneToLeaf("nonexistent", leaf1.id, "center");

    // Layout should be unchanged
    const after = useStore.getState();
    expect(allPanes(after.layout).map((p) => p.id).sort()).toEqual(["s1", "s2"]);
  });

  it("dissolves group when move reduces to 1 member", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const { activeGroupId } = useStore.getState();
    expect(activeGroupId).not.toBeNull();

    const state = useStore.getState();
    const leaf2 = findLeafByPaneId(state.layout, "s2")!;

    // Move s1 to center of s2 (replaces s2, removes s1 leaf → single leaf)
    useStore.getState().movePaneToLeaf("s1", leaf2.id, "center");

    const after = useStore.getState();
    // Group should be dissolved (only 1 pane left)
    expect(after.groups[activeGroupId!]).toBeUndefined();
    expect(after.activeGroupId).toBeNull();
  });
});

// ── closeLeaf ────────────────────────────────────────────────────────

describe("closeLeaf", () => {
  it("removes a leaf and focuses the sibling", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const state = useStore.getState();
    const leaf1 = findLeafByPaneId(state.layout, "s1")!;

    useStore.getState().closeLeaf(leaf1.id);

    const after = useStore.getState();
    expect(after.layout.kind).toBe("leaf");
    expect(after.activePane).toEqual(sessionPane("s2"));
  });

  it("dissolves group when closing reduces to 1 member", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const { activeGroupId } = useStore.getState();
    const state = useStore.getState();
    const leaf1 = findLeafByPaneId(state.layout, "s1")!;

    useStore.getState().closeLeaf(leaf1.id);

    const after = useStore.getState();
    expect(after.groups[activeGroupId!]).toBeUndefined();
    expect(after.activeGroupId).toBeNull();
  });

  it("does not remove the last leaf", () => {
    setupSinglePane("s1");
    const { focusedLeafId, layout } = useStore.getState();

    useStore.getState().closeLeaf(focusedLeafId);

    // State should be unchanged (can't close last leaf)
    const after = useStore.getState();
    expect(after.focusedLeafId).toBe(focusedLeafId);
    expect(after.layout).toBe(layout);
  });

  it("keeps group alive when 3→2 members", () => {
    setupSplitView("s1", "s2");
    const { focusedLeafId, activeGroupId } = useStore.getState();

    // Add a third pane
    useStore.getState().splitLeafWithPane(
      focusedLeafId, "vertical", "second", sessionPane("s3"),
    );

    const stateWith3 = useStore.getState();
    expect(stateWith3.groups[activeGroupId!].memberPaneIds).toHaveLength(3);

    // Close one pane (s3 is in the focused leaf after the split)
    const leaf3 = findLeafByPaneId(stateWith3.layout, "s3")!;
    useStore.getState().closeLeaf(leaf3.id);

    const after = useStore.getState();
    // Group should still exist with 2 members
    expect(after.groups[activeGroupId!]).toBeDefined();
    expect(after.groups[activeGroupId!].memberPaneIds).toHaveLength(2);
  });
});

// ── Group helpers ────────────────────────────────────────────────────

describe("getGroupForPane", () => {
  it("finds the group containing a pane", () => {
    const groups: Record<string, PaneGroup> = {
      g1: {
        id: "g1",
        color: "#53bdfa",
        memberPaneIds: ["s1", "s2"],
        savedLayout: { kind: "leaf", id: "l1", pane: null },
        savedFocusedLeafId: "l1",
      },
    };
    expect(getGroupForPane(groups, "s1")?.id).toBe("g1");
    expect(getGroupForPane(groups, "s2")?.id).toBe("g1");
  });

  it("returns null when pane not in any group", () => {
    const groups: Record<string, PaneGroup> = {
      g1: {
        id: "g1",
        color: "#53bdfa",
        memberPaneIds: ["s1"],
        savedLayout: { kind: "leaf", id: "l1", pane: null },
        savedFocusedLeafId: "l1",
      },
    };
    expect(getGroupForPane(groups, "s99")).toBeNull();
  });

  it("returns null for empty groups record", () => {
    expect(getGroupForPane({}, "s1")).toBeNull();
  });
});

// ── setLeafSizes snapshot sync ───────────────────────────────────────

describe("setLeafSizes", () => {
  it("syncs group snapshot when resizing within a group", () => {
    setupSplitView("s1", "s2");
    const { activeGroupId, layout } = useStore.getState();
    const branchId = layout.kind === "branch" ? layout.id : "";

    useStore.getState().setLeafSizes(branchId, [30, 70]);

    const after = useStore.getState();
    const group = after.groups[activeGroupId!];
    // Group snapshot should also have the updated sizes
    if (group.savedLayout.kind === "branch") {
      expect(group.savedLayout.sizes).toEqual([30, 70]);
    }
  });
});

// ── setFocusedLeaf ───────────────────────────────────────────────────

describe("setFocusedLeaf", () => {
  it("updates focusedLeafId and derives activePane", () => {
    const { pane1, pane2 } = setupSplitView("s1", "s2");
    const state = useStore.getState();
    const leaf1 = findLeafByPaneId(state.layout, "s1")!;

    useStore.getState().setFocusedLeaf(leaf1.id);

    const after = useStore.getState();
    expect(after.focusedLeafId).toBe(leaf1.id);
    expect(after.activePane).toEqual(sessionPane("s1"));
  });
});
