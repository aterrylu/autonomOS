import type { ActivePane } from "../store";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TabItem {
  id: string;
  pane: ActivePane;
}

export interface LayoutLeaf {
  kind: "leaf";
  id: string;
  tabs: TabItem[];
  activeTabIndex: number;
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
export function newTabId(): string {
  return `tab-${Date.now()}-${++_idCounter}`;
}

// ── Tab helpers ────────────────────────────────────────────────────────────

/** Get the active tab's pane from a leaf, or null if no tabs. */
export function activeTabPane(leaf: LayoutLeaf): ActivePane | null {
  const tab = leaf.tabs[leaf.activeTabIndex];
  return tab?.pane ?? null;
}

/** Create a TabItem from an ActivePane. */
export function makeTab(pane: ActivePane): TabItem {
  return { id: newTabId(), pane };
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Find a leaf node by id. Returns null if not found. */
export function findLeaf(node: LayoutNode, leafId: string): LayoutLeaf | null {
  if (node.kind === "leaf") return node.id === leafId ? node : null;
  return findLeaf(node.first, leafId) ?? findLeaf(node.second, leafId);
}

/** Collect all leaf ids in order (depth-first, first before second). */
export function allLeafIds(node: LayoutNode): string[] {
  if (node.kind === "leaf") return [node.id];
  return [...allLeafIds(node.first), ...allLeafIds(node.second)];
}

/** Collect all panes referenced by leaf nodes (active tabs only). */
export function allPanes(node: LayoutNode): ActivePane[] {
  if (node.kind === "leaf") {
    const p = activeTabPane(node);
    return p ? [p] : [];
  }
  return [...allPanes(node.first), ...allPanes(node.second)];
}

/** Collect ALL panes across all tabs in all leaves (not just active tabs). */
export function allTabPanes(node: LayoutNode): ActivePane[] {
  if (node.kind === "leaf") {
    return node.tabs.map((t) => t.pane);
  }
  return [...allTabPanes(node.first), ...allTabPanes(node.second)];
}

/**
 * Derive the "active pane" from the layout — the active tab's pane in the focused leaf.
 * Falls back to the first pane in the tree if focused leaf has none.
 */
export function derivedActivePane(
  node: LayoutNode,
  focusedLeafId: string,
): ActivePane | null {
  const leaf = findLeaf(node, focusedLeafId);
  if (leaf) {
    const p = activeTabPane(leaf);
    if (p) return p;
  }
  const panes = allPanes(node);
  return panes[0] ?? null;
}

/**
 * Split a leaf into a branch. The existing leaf becomes `first` or `second`
 * depending on `newSide` — the new leaf lands on the opposite side.
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
    tabs: newPane ? [makeTab(newPane)] : [],
    activeTabIndex: 0,
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
 * parent branch. Returns null if the root leaf itself is removed.
 */
export function removeLeaf(
  root: LayoutNode,
  leafId: string,
): LayoutNode | null {
  if (root.kind === "leaf") {
    return root.id === leafId ? null : root;
  }

  if (root.first.kind === "leaf" && root.first.id === leafId) {
    return root.second;
  }
  if (root.second.kind === "leaf" && root.second.id === leafId) {
    return root.first;
  }

  const newFirst = removeLeaf(root.first, leafId);
  const newSecond = removeLeaf(root.second, leafId);

  if (newFirst === null) return root.second;
  if (newSecond === null) return root.first;

  return { ...root, first: newFirst, second: newSecond };
}

/**
 * Set the pane in a specific leaf's active tab (replaces active tab content).
 * If the leaf has no tabs, creates one.
 */
export function setLeafPane(
  root: LayoutNode,
  leafId: string,
  pane: ActivePane | null,
): LayoutNode {
  if (root.kind === "leaf") {
    if (root.id !== leafId) return root;
    if (!pane) return { ...root, tabs: [], activeTabIndex: 0 };
    if (root.tabs.length === 0) {
      return { ...root, tabs: [makeTab(pane)], activeTabIndex: 0 };
    }
    // Replace active tab's pane
    const newTabs = [...root.tabs];
    newTabs[root.activeTabIndex] = {
      ...newTabs[root.activeTabIndex],
      pane,
    };
    return { ...root, tabs: newTabs };
  }
  return {
    ...root,
    first: setLeafPane(root.first, leafId, pane),
    second: setLeafPane(root.second, leafId, pane),
  };
}

/** Add a tab to a leaf. Returns updated tree. */
export function addTab(
  root: LayoutNode,
  leafId: string,
  pane: ActivePane,
): LayoutNode {
  if (root.kind === "leaf") {
    if (root.id !== leafId) return root;
    const newTabs = [...root.tabs, makeTab(pane)];
    return { ...root, tabs: newTabs, activeTabIndex: newTabs.length - 1 };
  }
  return {
    ...root,
    first: addTab(root.first, leafId, pane),
    second: addTab(root.second, leafId, pane),
  };
}

/** Remove a tab from a leaf. If last tab, the leaf becomes empty. */
export function removeTab(
  root: LayoutNode,
  leafId: string,
  tabId: string,
): LayoutNode {
  if (root.kind === "leaf") {
    if (root.id !== leafId) return root;
    const idx = root.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return root;
    const newTabs = root.tabs.filter((t) => t.id !== tabId);
    let newIndex = root.activeTabIndex;
    if (newIndex >= newTabs.length) newIndex = Math.max(0, newTabs.length - 1);
    return { ...root, tabs: newTabs, activeTabIndex: newIndex };
  }
  return {
    ...root,
    first: removeTab(root.first, leafId, tabId),
    second: removeTab(root.second, leafId, tabId),
  };
}

/** Set the active tab index on a leaf. */
export function setActiveTab(
  root: LayoutNode,
  leafId: string,
  tabIndex: number,
): LayoutNode {
  if (root.kind === "leaf") {
    if (root.id !== leafId) return root;
    const clamped = Math.max(0, Math.min(tabIndex, root.tabs.length - 1));
    return { ...root, activeTabIndex: clamped };
  }
  return {
    ...root,
    first: setActiveTab(root.first, leafId, tabIndex),
    second: setActiveTab(root.second, leafId, tabIndex),
  };
}

/** Update the sizes of a branch. */
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

/** Find the "next" leaf id in DFS order. Wraps around. */
export function nextLeafId(root: LayoutNode, currentLeafId: string): string {
  const ids = allLeafIds(root);
  const idx = ids.indexOf(currentLeafId);
  if (idx === -1 || ids.length === 1) return currentLeafId;
  return ids[(idx + 1) % ids.length];
}

/** Find the leaf whose active tab matches a given pane id. */
export function findLeafByPaneId(
  node: LayoutNode,
  paneId: string,
): LayoutLeaf | null {
  if (node.kind === "leaf") {
    // Check all tabs, not just active — so switchPane can find backgrounded tabs
    return node.tabs.some((t) => t.pane.id === paneId) ? node : null;
  }
  return (
    findLeafByPaneId(node.first, paneId) ??
    findLeafByPaneId(node.second, paneId)
  );
}

/** Create an initial single-leaf root from an optional active pane. */
export function makeRootLeaf(pane: ActivePane | null): LayoutLeaf {
  return {
    kind: "leaf",
    id: newLeafId(),
    tabs: pane ? [makeTab(pane)] : [],
    activeTabIndex: 0,
  };
}

// ── Migration ─────────────────────────────────────────────────────────────

/**
 * Migrate a persisted layout tree from the old single-pane format
 * (LayoutLeaf.pane) to the new tabs format (LayoutLeaf.tabs[]).
 */
export function migrateLayout(node: unknown): LayoutNode {
  if (!node || typeof node !== "object") return makeRootLeaf(null);
  const n = node as Record<string, unknown>;

  if (n.kind === "leaf") {
    // Already migrated?
    if (Array.isArray(n.tabs)) {
      return n as unknown as LayoutLeaf;
    }
    // Old format: { kind: "leaf", id, pane }
    const oldPane = n.pane as ActivePane | null | undefined;
    return {
      kind: "leaf",
      id: (n.id as string) || newLeafId(),
      tabs: oldPane ? [makeTab(oldPane)] : [],
      activeTabIndex: 0,
    };
  }

  if (n.kind === "branch") {
    return {
      kind: "branch",
      id: (n.id as string) || newBranchId(),
      direction: (n.direction as "horizontal" | "vertical") || "horizontal",
      sizes: (n.sizes as [number, number]) || [50, 50],
      first: migrateLayout(n.first),
      second: migrateLayout(n.second),
    };
  }

  return makeRootLeaf(null);
}
