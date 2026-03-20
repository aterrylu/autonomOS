import { describe, expect, it } from "vitest";
import type { ActivePane } from "../store";
import {
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
  nextLeafId,
  removeLeaf,
  setLeafPane,
  updateBranchSizes,
} from "./layoutTree";

// ── Helpers ──────────────────────────────────────────────────────────

const pane = (id: string): ActivePane => ({ type: "session", id });

function leaf(id: string, p: ActivePane | null = null): LayoutLeaf {
  return { kind: "leaf", id, pane: p };
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

  it("returns null for null-pane leaves", () => {
    const tree = leaf("a", null);
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
    const tree = branch(
      "b1",
      branch("b2", leaf("a"), leaf("b")),
      leaf("c"),
    );
    expect(allLeafIds(tree)).toEqual(["a", "b", "c"]);
  });
});

// ── allPanes ─────────────────────────────────────────────────────────

describe("allPanes", () => {
  it("returns empty array for null-pane leaf", () => {
    expect(allPanes(leaf("a", null))).toEqual([]);
  });

  it("collects all non-null panes", () => {
    const tree = branch(
      "br",
      leaf("a", pane("s1")),
      branch("br2", leaf("b", null), leaf("c", pane("s2"))),
    );
    expect(allPanes(tree)).toEqual([pane("s1"), pane("s2")]);
  });
});

// ── derivedActivePane ────────────────────────────────────────────────

describe("derivedActivePane", () => {
  it("returns focused leaf's pane", () => {
    const tree = branch("br", leaf("a", pane("s1")), leaf("b", pane("s2")));
    expect(derivedActivePane(tree, "b")).toEqual(pane("s2"));
  });

  it("falls back to first pane if focused leaf has null pane", () => {
    const tree = branch("br", leaf("a", pane("s1")), leaf("b", null));
    expect(derivedActivePane(tree, "b")).toEqual(pane("s1"));
  });

  it("returns null if no panes exist", () => {
    const tree = branch("br", leaf("a", null), leaf("b", null));
    expect(derivedActivePane(tree, "a")).toBeNull();
  });

  it("returns null for non-existent focusedLeafId", () => {
    const tree = leaf("a", null);
    expect(derivedActivePane(tree, "nonexistent")).toBeNull();
  });
});

// ── insertLeaf ───────────────────────────────────────────────────────

describe("insertLeaf", () => {
  it("splits a single leaf into a branch", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot, newLeafId: newId } = insertLeaf(
      root, "a", "horizontal", "second", pane("s2"),
    );
    expect(newRoot.kind).toBe("branch");
    const br = newRoot as LayoutBranch;
    expect(br.direction).toBe("horizontal");
    expect(br.sizes).toEqual([50, 50]);
    expect((br.first as LayoutLeaf).pane).toEqual(pane("s1"));
    expect((br.second as LayoutLeaf).pane).toEqual(pane("s2"));
    expect((br.second as LayoutLeaf).id).toBe(newId);
  });

  it("places new leaf on first side when newSide=first", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot } = insertLeaf(
      root, "a", "vertical", "first", pane("s2"),
    );
    const br = newRoot as LayoutBranch;
    expect((br.first as LayoutLeaf).pane).toEqual(pane("s2"));
    expect((br.second as LayoutLeaf).pane).toEqual(pane("s1"));
  });

  it("inserts with null pane (loading placeholder)", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot } = insertLeaf(root, "a", "horizontal", "second", null);
    const br = newRoot as LayoutBranch;
    expect((br.second as LayoutLeaf).pane).toBeNull();
  });

  it("returns tree unchanged when target not found", () => {
    const root = leaf("a", pane("s1"));
    const { root: newRoot } = insertLeaf(root, "nonexistent", "horizontal", "second", pane("s2"));
    // The tree should still have a branch because insertLeaf always creates a new leaf
    // But the original leaf is unchanged since target wasn't found
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
    const tree = branch(
      "b1",
      leaf("a"),
      branch("b2", leaf("b"), leaf("c")),
    );
    const result = removeLeaf(tree, "b");
    expect(result).not.toBeNull();
    // After removing "b", b2's sibling "c" replaces b2
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
  it("sets pane on target leaf", () => {
    const tree = leaf("a", null);
    const result = setLeafPane(tree, "a", pane("s1"));
    expect((result as LayoutLeaf).pane).toEqual(pane("s1"));
  });

  it("sets pane in nested tree", () => {
    const tree = branch("br", leaf("a", null), leaf("b", null));
    const result = setLeafPane(tree, "b", pane("s2"));
    const br = result as LayoutBranch;
    expect((br.second as LayoutLeaf).pane).toEqual(pane("s2"));
    expect((br.first as LayoutLeaf).pane).toBeNull();
  });

  it("clears pane by setting null", () => {
    const tree = leaf("a", pane("s1"));
    const result = setLeafPane(tree, "a", null);
    expect((result as LayoutLeaf).pane).toBeNull();
  });

  it("returns tree unchanged when leaf not found", () => {
    const tree = leaf("a", pane("s1"));
    const result = setLeafPane(tree, "z", pane("s2"));
    expect((result as LayoutLeaf).pane).toEqual(pane("s1"));
  });

  it("does not mutate the original tree", () => {
    const tree = leaf("a", pane("s1"));
    const originalJson = JSON.stringify(tree);
    setLeafPane(tree, "a", pane("s2"));
    expect(JSON.stringify(tree)).toBe(originalJson);
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
  it("creates a leaf with the given pane", () => {
    const result = makeRootLeaf(pane("s1"));
    expect(result.kind).toBe("leaf");
    expect(result.pane).toEqual(pane("s1"));
    expect(result.id).toMatch(/^leaf-/);
  });

  it("creates a leaf with null pane", () => {
    const result = makeRootLeaf(null);
    expect(result.pane).toBeNull();
  });

  it("generates unique ids", () => {
    const a = makeRootLeaf(null);
    const b = makeRootLeaf(null);
    expect(a.id).not.toBe(b.id);
  });
});
