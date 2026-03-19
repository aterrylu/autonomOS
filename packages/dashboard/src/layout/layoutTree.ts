import type { ActivePane } from "../store";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LayoutLeaf {
  kind: "leaf";
  id: string;
  pane: ActivePane | null;
}

export interface LayoutBranch {
  kind: "branch";
  id: string;
  direction: "horizontal" | "vertical";
  /** Percentages [first, second], sum to 100. Persisted for restore. */
  sizes: [number, number];
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = LayoutLeaf | LayoutBranch;

export type SplitDirection = "horizontal" | "vertical";
export type SplitSide = "first" | "second";

// ── ID generation ──────────────────────────────────────────────────────────

let _idCounter = 0;
export function newLeafId(): string {
  return `leaf-${Date.now()}-${++_idCounter}`;
}
export function newBranchId(): string {
  return `branch-${Date.now()}-${++_idCounter}`;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Find a leaf node by id. Returns null if not found. */
export function findLeaf(
  node: LayoutNode,
  leafId: string,
): LayoutLeaf | null {
  if (node.kind === "leaf") return node.id === leafId ? node : null;
  return findLeaf(node.first, leafId) ?? findLeaf(node.second, leafId);
}

/** Collect all leaf ids in order (depth-first, first before second). */
export function allLeafIds(node: LayoutNode): string[] {
  if (node.kind === "leaf") return [node.id];
  return [...allLeafIds(node.first), ...allLeafIds(node.second)];
}

/** Collect all panes referenced by leaf nodes. */
export function allPanes(node: LayoutNode): ActivePane[] {
  if (node.kind === "leaf") return node.pane ? [node.pane] : [];
  return [...allPanes(node.first), ...allPanes(node.second)];
}

/**
 * Derive the "active pane" from the layout — the pane in the focused leaf.
 * Falls back to the first pane in the tree if focused leaf has none.
 */
export function derivedActivePane(
  node: LayoutNode,
  focusedLeafId: string,
): ActivePane | null {
  const leaf = findLeaf(node, focusedLeafId);
  if (leaf?.pane) return leaf.pane;
  // Fallback: first non-null pane
  const panes = allPanes(node);
  return panes[0] ?? null;
}

/**
 * Split a leaf into a branch. The existing leaf becomes `first` or `second`
 * depending on `newSide` — the new leaf lands on the opposite side.
 *
 * Returns the new tree root. If the target leaf is not found, returns the
 * tree unchanged.
 */
export function insertLeaf(
  root: LayoutNode,
  targetLeafId: string,
  direction: SplitDirection,
  newSide: SplitSide,
  newPane: ActivePane | null,
): { root: LayoutNode; newLeafId: string } {
  const newLeaf: LayoutLeaf = {
    kind: "leaf",
    id: newLeafId(),
    pane: newPane,
  };

  function walk(node: LayoutNode): LayoutNode {
    if (node.kind === "leaf") {
      if (node.id !== targetLeafId) return node;
      const branch: LayoutBranch = {
        kind: "branch",
        id: newBranchId(),
        direction,
        sizes: [50, 50],
        first: newSide === "second" ? node : newLeaf,
        second: newSide === "second" ? newLeaf : node,
      };
      return branch;
    }
    return {
      ...node,
      first: walk(node.first),
      second: walk(node.second),
    };
  }

  return { root: walk(root), newLeafId: newLeaf.id };
}

/**
 * Remove a leaf from the tree. Its sibling collapses up to replace the
 * parent branch. Returns null if the root leaf itself is removed (tree
 * becomes empty — caller should handle this case).
 */
export function removeLeaf(
  root: LayoutNode,
  leafId: string,
): LayoutNode | null {
  if (root.kind === "leaf") {
    return root.id === leafId ? null : root;
  }

  // Check if the target is a direct child
  if (root.first.kind === "leaf" && root.first.id === leafId) {
    return root.second;
  }
  if (root.second.kind === "leaf" && root.second.id === leafId) {
    return root.first;
  }

  const newFirst = removeLeaf(root.first, leafId);
  const newSecond = removeLeaf(root.second, leafId);

  // If a child branch collapsed to null, promote the other
  if (newFirst === null) return root.second;
  if (newSecond === null) return root.first;

  return { ...root, first: newFirst, second: newSecond };
}

/**
 * Set the pane in a specific leaf (e.g., drag-drop center).
 */
export function setLeafPane(
  root: LayoutNode,
  leafId: string,
  pane: ActivePane | null,
): LayoutNode {
  if (root.kind === "leaf") {
    return root.id === leafId ? { ...root, pane } : root;
  }
  return {
    ...root,
    first: setLeafPane(root.first, leafId, pane),
    second: setLeafPane(root.second, leafId, pane),
  };
}

/**
 * Update the sizes of a branch (from PanelGroup onLayout callback).
 */
export function updateBranchSizes(
  root: LayoutNode,
  branchId: string,
  sizes: [number, number],
): LayoutNode {
  if (root.kind === "leaf") return root;
  if (root.id === branchId) return { ...root, sizes };
  return {
    ...root,
    first: updateBranchSizes(root.first, branchId, sizes),
    second: updateBranchSizes(root.second, branchId, sizes),
  };
}

/**
 * Find the "next" leaf id in DFS order after the given leaf.
 * Wraps around to the first leaf.
 */
export function nextLeafId(root: LayoutNode, currentLeafId: string): string {
  const ids = allLeafIds(root);
  const idx = ids.indexOf(currentLeafId);
  if (idx === -1 || ids.length === 1) return currentLeafId;
  return ids[(idx + 1) % ids.length];
}

/** Create an initial single-leaf root from an optional active pane. */
export function makeRootLeaf(pane: ActivePane | null): LayoutLeaf {
  return { kind: "leaf", id: newLeafId(), pane };
}
