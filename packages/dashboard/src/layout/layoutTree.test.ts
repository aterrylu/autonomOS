import { describe, expect, it } from "vitest";
import type { ActivePane } from "../store";
import {
  activeTabPane,
  addTab,
  allLeafIds,
  allPanes,
  derivedActivePane,
  findLeaf,
  findLeafByPaneId,
  insertLeaf,
  type LayoutBranch,
  type LayoutLeaf,
  type LayoutNode,
  makeRootLeaf,
  makeTab,
  migrateLayout,
  nextLeafId,
  pruneStaleSessionTabs,
  removeLeaf,
  removeTab,
  setActiveTab,
  setLeafPane,
  updateBranchSizes,
} from "./layoutTree";

// ── Helpers ──────────────────────────────────────────────────────────

const pane = (id: string): ActivePane => ({ type: "session", id });

function leaf(id: string, p: ActivePane | null = null): LayoutLeaf {
  return {
    kind: "leaf",
    id,
    tabs: p ? [makeTab(p)] : [],
    activeTabIndex: 0,
  };
}

function branch(
  id: string,
  first: LayoutNode,
  second: LayoutNode,
  dir: "horizontal" | "vertical" = "horizontal",
  sizes: [number, number] = [50, 50],
): LayoutBranch {
  return { kind: "branch", id, direction: dir, first, second, sizes };
}

// ── findLeaf ─────────────────────────────────────────────────────────

describe("findLeaf", () => {
  it("finds a leaf in a single-leaf tree", () => {
    const l = leaf("a");
    expect(findLeaf(l, "a")).toBe(l);
  });

  it("returns null for non-existent id in single leaf", () => {
    expect(findLeaf(leaf("a"), "b")).toBeNull();
  });

  it("finds a leaf in a branch tree", () => {
    const target = leaf("b", pane("s1"));
    const tree = branch("br", leaf("a"), target);
    expect(findLeaf(tree, "b")).toBe(target);
  });

  it("finds deeply nested leaf", () => {
    const target = leaf("c");
    const tree = branch("br1", leaf("a"), branch("br2", leaf("b"), target));
    expect(findLeaf(tree, "c")).toBe(target);
  });

  it("returns null when leaf not in tree", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    expect(findLeaf(tree, "z")).toBeNull();
  });
});

// ── findLeafByPaneId ─────────────────────────────────────────────────

describe("findLeafByPaneId", () => {
  it("finds leaf by pane id", () => {
    const target = leaf("L1", pane("session-42"));
    const tree = branch("br", leaf("L0", pane("session-1")), target);
    expect(findLeafByPaneId(tree, "session-42")).toBe(target);
  });

  it("returns null when pane not in tree", () => {
    const tree = branch("br", leaf("a", pane("s1")), leaf("b", pane("s2")));
    expect(findLeafByPaneId(tree, "s99")).toBeNull();
  });

  it("returns null for empty leaves", () => {
    const tree = leaf("a");
    expect(findLeafByPaneId(tree, "anything")).toBeNull();
  });

  it("finds in deeply nested tree", () => {
    const target = leaf("deep", pane("target"));
    const tree = branch(
      "b1",
      branch("b2", leaf("x", pane("x")), leaf("y", pane("y"))),
      branch("b3", leaf("z", pane("z")), target),
    );
    expect(findLeafByPaneId(tree, "target")).toBe(target);
  });
});

// ── activeTabPane ────────────────────────────────────────────────────

describe("activeTabPane", () => {
  it("returns active tab pane", () => {
    const l = leaf("a", pane("s1"));
    expect(activeTabPane(l)).toEqual(pane("s1"));
  });

  it("returns null for empty leaf", () => {
    const l = leaf("a");
    expect(activeTabPane(l)).toBeNull();
  });

  it("returns correct tab when multiple tabs", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [makeTab(pane("s1")), makeTab(pane("s2")), makeTab(pane("s3"))],
      activeTabIndex: 1,
    };
    expect(activeTabPane(l)).toEqual(pane("s2"));
  });
});

// ── allLeafIds ───────────────────────────────────────────────────────

describe("allLeafIds", () => {
  it("returns single id for leaf", () => {
    expect(allLeafIds(leaf("a"))).toEqual(["a"]);
  });

  it("returns DFS order (first before second)", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    expect(allLeafIds(tree)).toEqual(["a", "b"]);
  });

  it("handles nested branches", () => {
    const tree = branch("b1", branch("b2", leaf("a"), leaf("b")), leaf("c"));
    expect(allLeafIds(tree)).toEqual(["a", "b", "c"]);
  });
});

// ── allPanes ─────────────────────────────────────────────────────────

describe("allPanes", () => {
  it("returns empty array for empty leaf", () => {
    expect(allPanes(leaf("a"))).toEqual([]);
  });

  it("collects all active tab panes", () => {
    const tree = branch(
      "br",
      leaf("a", pane("s1")),
      branch("br2", leaf("b"), leaf("c", pane("s2"))),
    );
    expect(allPanes(tree)).toEqual([pane("s1"), pane("s2")]);
  });
});

// ── derivedActivePane ────────────────────────────────────────────────

describe("derivedActivePane", () => {
  it("returns focused leaf's active tab pane", () => {
    const tree = branch("br", leaf("a", pane("s1")), leaf("b", pane("s2")));
    expect(derivedActivePane(tree, "b")).toEqual(pane("s2"));
  });

  it("falls back to first pane if focused leaf is empty", () => {
    const tree = branch("br", leaf("a", pane("s1")), leaf("b"));
    expect(derivedActivePane(tree, "b")).toEqual(pane("s1"));
  });

  it("returns null if no panes exist", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    expect(derivedActivePane(tree, "a")).toBeNull();
  });

  it("returns null for non-existent focusedLeafId", () => {
    const tree = leaf("a");
    expect(derivedActivePane(tree, "nonexistent")).toBeNull();
  });
});

// ── insertLeaf ───────────────────────────────────────────────────────

describe("insertLeaf", () => {
  it("splits a single leaf into a branch", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot, newLeafId: newId } = insertLeaf(
      root,
      "a",
      "horizontal",
      "second",
      pane("s2"),
    );
    expect(newRoot.kind).toBe("branch");
    const br = newRoot as LayoutBranch;
    expect(br.direction).toBe("horizontal");
    expect(br.sizes).toEqual([50, 50]);
    expect(activeTabPane(br.first as LayoutLeaf)).toEqual(pane("s1"));
    expect(activeTabPane(br.second as LayoutLeaf)).toEqual(pane("s2"));
    expect((br.second as LayoutLeaf).id).toBe(newId);
  });

  it("places new leaf on first side when newSide=first", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot } = insertLeaf(
      root,
      "a",
      "vertical",
      "first",
      pane("s2"),
    );
    const br = newRoot as LayoutBranch;
    expect(activeTabPane(br.first as LayoutLeaf)).toEqual(pane("s2"));
    expect(activeTabPane(br.second as LayoutLeaf)).toEqual(pane("s1"));
  });

  it("inserts with null pane (empty leaf)", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot } = insertLeaf(
      root,
      "a",
      "horizontal",
      "second",
      null,
    );
    const br = newRoot as LayoutBranch;
    expect((br.second as LayoutLeaf).tabs).toEqual([]);
  });

  it("returns tree unchanged when target not found", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot } = insertLeaf(
      root,
      "nonexistent",
      "horizontal",
      "second",
      pane("s2"),
    );
    expect(newRoot.kind).toBe("leaf");
    expect((newRoot as LayoutLeaf).id).toBe("a");
  });

  it("does not mutate the original tree", () => {
    const original = leaf("a", pane("s1"));
    const originalJson = JSON.stringify(original);
    insertLeaf(original, "a", "horizontal", "second", pane("s2"));
    expect(JSON.stringify(original)).toBe(originalJson);
  });
});

// ── removeLeaf ───────────────────────────────────────────────────────

describe("removeLeaf", () => {
  it("returns null when removing the only leaf (root)", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("returns sibling when removing from 2-leaf branch", () => {
    const tree = branch("br", leaf("a", pane("s1")), leaf("b", pane("s2")));
    const result = removeLeaf(tree, "a");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("leaf");
    expect((result as LayoutLeaf).id).toBe("b");
  });

  it("collapses parent correctly for deeper trees", () => {
    const tree = branch("b1", leaf("a"), branch("b2", leaf("b"), leaf("c")));
    const result = removeLeaf(tree, "b");
    expect(result).not.toBeNull();
    const r = result as LayoutBranch;
    expect(r.kind).toBe("branch");
    expect((r.second as LayoutLeaf).id).toBe("c");
  });

  it("returns tree unchanged when leaf not found", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    const result = removeLeaf(tree, "z");
    expect(result).not.toBeNull();
    expect(allLeafIds(result!)).toEqual(["a", "b"]);
  });

  it("does not mutate the original tree", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    const originalJson = JSON.stringify(tree);
    removeLeaf(tree, "a");
    expect(JSON.stringify(tree)).toBe(originalJson);
  });
});

// ── setLeafPane ──────────────────────────────────────────────────────

describe("setLeafPane", () => {
  it("sets pane on empty leaf (creates tab)", () => {
    const tree = leaf("a");
    const result = setLeafPane(tree, "a", pane("s1")) as LayoutLeaf;
    expect(activeTabPane(result)).toEqual(pane("s1"));
    expect(result.tabs.length).toBe(1);
  });

  it("sets pane in nested tree", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    const result = setLeafPane(tree, "b", pane("s2"));
    const br = result as LayoutBranch;
    expect(activeTabPane(br.second as LayoutLeaf)).toEqual(pane("s2"));
    expect((br.first as LayoutLeaf).tabs.length).toBe(0);
  });

  it("clears tabs by setting null", () => {
    const tree = leaf("a", pane("s1"));
    const result = setLeafPane(tree, "a", null) as LayoutLeaf;
    expect(result.tabs).toEqual([]);
  });

  it("returns tree unchanged when leaf not found", () => {
    const tree = leaf("a", pane("s1"));
    const result = setLeafPane(tree, "z", pane("s2")) as LayoutLeaf;
    expect(activeTabPane(result)).toEqual(pane("s1"));
  });

  it("does not mutate the original tree", () => {
    const tree = leaf("a", pane("s1"));
    const originalJson = JSON.stringify(tree);
    setLeafPane(tree, "a", pane("s2"));
    expect(JSON.stringify(tree)).toBe(originalJson);
  });
});

// ── addTab ───────────────────────────────────────────────────────────

describe("addTab", () => {
  it("adds a tab to an empty leaf", () => {
    const tree = leaf("a");
    const result = addTab(tree, "a", pane("s1")) as LayoutLeaf;
    expect(result.tabs.length).toBe(1);
    expect(result.activeTabIndex).toBe(0);
    expect(activeTabPane(result)).toEqual(pane("s1"));
  });

  it("adds a tab to a leaf with existing tabs", () => {
    const tree = leaf("a", pane("s1"));
    const result = addTab(tree, "a", pane("s2")) as LayoutLeaf;
    expect(result.tabs.length).toBe(2);
    expect(result.activeTabIndex).toBe(1); // new tab becomes active
    expect(activeTabPane(result)).toEqual(pane("s2"));
  });

  it("returns unchanged tree when leaf not found", () => {
    const tree = leaf("a", pane("s1"));
    const result = addTab(tree, "z", pane("s2")) as LayoutLeaf;
    expect(result.tabs.length).toBe(1);
  });
});

// ── removeTab ────────────────────────────────────────────────────────

describe("removeTab", () => {
  it("removes a tab by id", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [
        { id: "t1", pane: pane("s1") },
        { id: "t2", pane: pane("s2") },
      ],
      activeTabIndex: 0,
    };
    const result = removeTab(l, "a", "t1") as LayoutLeaf;
    expect(result.tabs.length).toBe(1);
    expect(result.tabs[0].id).toBe("t2");
  });

  it("adjusts activeTabIndex when removing the active tab", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [
        { id: "t1", pane: pane("s1") },
        { id: "t2", pane: pane("s2") },
      ],
      activeTabIndex: 1,
    };
    const result = removeTab(l, "a", "t2") as LayoutLeaf;
    expect(result.tabs.length).toBe(1);
    expect(result.activeTabIndex).toBe(0);
  });

  it("decrements activeTabIndex when removing tab before active (3+ tabs)", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [
        { id: "t1", pane: pane("s1") },
        { id: "t2", pane: pane("s2") },
        { id: "t3", pane: pane("s3") },
      ],
      activeTabIndex: 2, // t3 is active
    };
    const result = removeTab(l, "a", "t1") as LayoutLeaf;
    expect(result.tabs.length).toBe(2);
    expect(result.activeTabIndex).toBe(1); // t3 is still active, now at index 1
    expect(result.tabs[result.activeTabIndex].pane).toEqual(pane("s3"));
  });

  it("returns empty tabs when removing last tab", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [{ id: "t1", pane: pane("s1") }],
      activeTabIndex: 0,
    };
    const result = removeTab(l, "a", "t1") as LayoutLeaf;
    expect(result.tabs.length).toBe(0);
    expect(result.activeTabIndex).toBe(0);
  });
});

// ── setActiveTab ─────────────────────────────────────────────────────

describe("setActiveTab", () => {
  it("sets active tab index", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [makeTab(pane("s1")), makeTab(pane("s2"))],
      activeTabIndex: 0,
    };
    const result = setActiveTab(l, "a", 1) as LayoutLeaf;
    expect(result.activeTabIndex).toBe(1);
  });

  it("clamps to valid range", () => {
    const l: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [makeTab(pane("s1")), makeTab(pane("s2"))],
      activeTabIndex: 0,
    };
    const result = setActiveTab(l, "a", 99) as LayoutLeaf;
    expect(result.activeTabIndex).toBe(1);
  });
});

// ── updateBranchSizes ────────────────────────────────────────────────

describe("updateBranchSizes", () => {
  it("updates sizes on target branch", () => {
    const tree = branch("br", leaf("a"), leaf("b"), "horizontal", [50, 50]);
    const result = updateBranchSizes(tree, "br", [30, 70]);
    expect((result as LayoutBranch).sizes).toEqual([30, 70]);
  });

  it("returns tree unchanged when branch not found", () => {
    const tree = branch("br", leaf("a"), leaf("b"), "horizontal", [50, 50]);
    const result = updateBranchSizes(tree, "nonexistent", [30, 70]);
    expect((result as LayoutBranch).sizes).toEqual([50, 50]);
  });

  it("updates nested branch", () => {
    const inner = branch("inner", leaf("a"), leaf("b"), "vertical", [50, 50]);
    const tree = branch("outer", inner, leaf("c"));
    const result = updateBranchSizes(tree, "inner", [25, 75]);
    const outerBr = result as LayoutBranch;
    expect((outerBr.first as LayoutBranch).sizes).toEqual([25, 75]);
  });
});

// ── nextLeafId ───────────────────────────────────────────────────────

describe("nextLeafId", () => {
  it("returns next leaf in DFS order", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    expect(nextLeafId(tree, "a")).toBe("b");
  });

  it("wraps around to first leaf", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    expect(nextLeafId(tree, "b")).toBe("a");
  });

  it("returns same id for single-leaf tree", () => {
    const tree = leaf("a");
    expect(nextLeafId(tree, "a")).toBe("a");
  });

  it("returns same id when current not found in tree", () => {
    const tree = branch("br", leaf("a"), leaf("b"));
    expect(nextLeafId(tree, "z")).toBe("z");
  });
});

// ── makeRootLeaf ─────────────────────────────────────────────────────

describe("makeRootLeaf", () => {
  it("creates a leaf with the given pane as a tab", () => {
    const result = makeRootLeaf(pane("s1"));
    expect(result.kind).toBe("leaf");
    expect(result.tabs.length).toBe(1);
    expect(activeTabPane(result)).toEqual(pane("s1"));
    expect(result.id).toMatch(/^leaf-/);
  });

  it("creates an empty leaf with null pane", () => {
    const result = makeRootLeaf(null);
    expect(result.tabs).toEqual([]);
  });

  it("generates unique ids", () => {
    const a = makeRootLeaf(null);
    const b = makeRootLeaf(null);
    expect(a.id).not.toBe(b.id);
  });
});

// ── migrateLayout ────────────────────────────────────────────────────

describe("migrateLayout", () => {
  it("migrates old single-pane leaf to tabs format", () => {
    const old = { kind: "leaf", id: "a", pane: pane("s1") };
    const result = migrateLayout(old) as LayoutLeaf;
    expect(result.tabs.length).toBe(1);
    expect(result.tabs[0].pane).toEqual(pane("s1"));
    expect(result.activeTabIndex).toBe(0);
  });

  it("migrates old null-pane leaf to empty tabs", () => {
    const old = { kind: "leaf", id: "a", pane: null };
    const result = migrateLayout(old) as LayoutLeaf;
    expect(result.tabs).toEqual([]);
  });

  it("passes through already-migrated leaf", () => {
    const modern: LayoutLeaf = {
      kind: "leaf",
      id: "a",
      tabs: [makeTab(pane("s1"))],
      activeTabIndex: 0,
    };
    const result = migrateLayout(modern) as LayoutLeaf;
    expect(result.tabs.length).toBe(1);
  });

  it("migrates branches recursively", () => {
    const old = {
      kind: "branch",
      id: "br",
      direction: "horizontal",
      sizes: [50, 50],
      first: { kind: "leaf", id: "a", pane: pane("s1") },
      second: { kind: "leaf", id: "b", pane: pane("s2") },
    };
    const result = migrateLayout(old) as LayoutBranch;
    expect(result.kind).toBe("branch");
    expect(activeTabPane(result.first as LayoutLeaf)).toEqual(pane("s1"));
    expect(activeTabPane(result.second as LayoutLeaf)).toEqual(pane("s2"));
  });

  it("handles null/undefined input", () => {
    const result = migrateLayout(null);
    expect(result.kind).toBe("leaf");
  });
});

// ── pruneStaleSessionTabs ───────────────────────────────────────────

describe("pruneStaleSessionTabs", () => {
  // Helpers for multi-tab leaves
  function multiLeaf(
    id: string,
    panes: ActivePane[],
    activeTabIndex = 0,
  ): LayoutLeaf {
    return {
      kind: "leaf",
      id,
      tabs: panes.map((p) => ({ id: `tab-${p.id}`, pane: p })),
      activeTabIndex,
    };
  }

  const orgchart: ActivePane = { type: "orgchart", id: "orgchart" };
  const templates: ActivePane = { type: "templates", id: "templates" };
  const preview = (id: string): ActivePane => ({ type: "preview", id });

  describe("single leaf", () => {
    it("returns same reference when all tabs are valid", () => {
      const root = multiLeaf("L1", [pane("a"), pane("b")]);
      const result = pruneStaleSessionTabs(root, new Set(["a", "b"]));
      expect(result).toBe(root);
    });

    it("returns null when all tabs are stale", () => {
      const root = multiLeaf("L1", [pane("a"), pane("b")]);
      expect(pruneStaleSessionTabs(root, new Set())).toBeNull();
    });

    it("removes stale tabs and keeps valid ones", () => {
      const root = multiLeaf("L1", [pane("a"), pane("b"), pane("c")]);
      const result = pruneStaleSessionTabs(
        root,
        new Set(["a", "c"]),
      ) as LayoutLeaf;
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0].pane.id).toBe("a");
      expect(result.tabs[1].pane.id).toBe("c");
    });

    it("clamps activeTabIndex when active tab is pruned", () => {
      const root = multiLeaf("L1", [pane("a"), pane("b"), pane("c")], 2);
      const result = pruneStaleSessionTabs(
        root,
        new Set(["a", "b"]),
      ) as LayoutLeaf;
      expect(result.activeTabIndex).toBe(1);
    });

    it("clamps activeTabIndex to 0 when only one tab survives", () => {
      const root = multiLeaf("L1", [pane("a"), pane("b"), pane("c")], 1);
      const result = pruneStaleSessionTabs(root, new Set(["b"])) as LayoutLeaf;
      expect(result.tabs).toHaveLength(1);
      expect(result.activeTabIndex).toBe(0);
    });
  });

  describe("non-session tabs are never pruned", () => {
    it("keeps orgchart tabs", () => {
      const root = multiLeaf("L1", [orgchart]);
      expect(pruneStaleSessionTabs(root, new Set())).toBe(root);
    });

    it("keeps templates tabs", () => {
      const root = multiLeaf("L1", [templates]);
      expect(pruneStaleSessionTabs(root, new Set())).toBe(root);
    });

    it("keeps preview tabs", () => {
      const root = multiLeaf("L1", [preview("file.md")]);
      expect(pruneStaleSessionTabs(root, new Set())).toBe(root);
    });

    it("keeps non-session tabs while pruning stale sessions", () => {
      const root = multiLeaf("L1", [orgchart, pane("stale"), templates]);
      const result = pruneStaleSessionTabs(root, new Set()) as LayoutLeaf;
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0].pane).toEqual(orgchart);
      expect(result.tabs[1].pane).toEqual(templates);
    });
  });

  describe("branch trees", () => {
    it("returns same reference when nothing is stale", () => {
      const root = branch("B1", leaf("L1", pane("a")), leaf("L2", pane("b")));
      expect(pruneStaleSessionTabs(root, new Set(["a", "b"]))).toBe(root);
    });

    it("collapses to second child when first is all stale", () => {
      const second = leaf("L2", pane("b"));
      const root = branch("B1", leaf("L1", pane("stale")), second);
      expect(pruneStaleSessionTabs(root, new Set(["b"]))).toBe(second);
    });

    it("collapses to first child when second is all stale", () => {
      const first = leaf("L1", pane("a"));
      const root = branch("B1", first, leaf("L2", pane("stale")));
      expect(pruneStaleSessionTabs(root, new Set(["a"]))).toBe(first);
    });

    it("returns null when both children are all stale", () => {
      const root = branch("B1", leaf("L1", pane("x")), leaf("L2", pane("y")));
      expect(pruneStaleSessionTabs(root, new Set())).toBeNull();
    });

    it("handles deep nesting — collapses inner branch", () => {
      const root = branch(
        "B1",
        branch("B2", leaf("L1", pane("a")), leaf("L2", pane("stale"))),
        leaf("L3", pane("b")),
      );
      const result = pruneStaleSessionTabs(
        root,
        new Set(["a", "b"]),
      ) as LayoutBranch;
      expect(result.first.kind).toBe("leaf");
      expect((result.first as LayoutLeaf).id).toBe("L1");
      expect(result.second.kind).toBe("leaf");
      expect((result.second as LayoutLeaf).id).toBe("L3");
    });

    it("preserves referential equality for unchanged subtrees", () => {
      const validLeaf = leaf("L2", pane("b"));
      const root = branch("B1", leaf("L1", pane("stale")), validLeaf);
      expect(pruneStaleSessionTabs(root, new Set(["b"]))).toBe(validLeaf);
    });
  });

  describe("edge cases", () => {
    it("returns same reference for empty leaf (nothing to prune)", () => {
      const root: LayoutLeaf = {
        kind: "leaf",
        id: "L1",
        tabs: [],
        activeTabIndex: 0,
      };
      // Empty leaf has no stale tabs — kept.length === tabs.length, so no change
      expect(pruneStaleSessionTabs(root, new Set())).toBe(root);
    });

    it("handles valid set with extra IDs not in tree", () => {
      const root = leaf("L1", pane("a"));
      expect(pruneStaleSessionTabs(root, new Set(["a", "b", "c"]))).toBe(root);
    });
  });
});
