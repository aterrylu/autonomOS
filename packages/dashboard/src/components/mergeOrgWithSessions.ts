import type { SessionInfo } from "../store";

/** Org chart node as returned by /api/agents/tree. */
export interface OrgNode {
  name: string;
  claudeSessionId?: string;
  status?: string;
  template?: string;
  project?: string;
  children: OrgNode[];
}

/** Org node joined with its live session (if matched). */
export interface SidebarHierarchyNode {
  org: OrgNode;
  session: SessionInfo | undefined;
  children: SidebarHierarchyNode[];
}

/**
 * Merge org chart tree with live sessions.
 *
 * Matching strategy: prefer `claudeSessionId` (stable identifier), fall back to
 * case-insensitive name match (for legacy org nodes or backwards compat).
 * Matching by name alone is fragile — rename/case/whitespace drift silently
 * severs a node from its session and the whole subtree gets pruned.
 *
 * When hideStopped is true AND sessions have loaded, prune nodes with no live
 * descendant. If sessions is empty (hasn't loaded yet), we skip pruning so the
 * hierarchy isn't wiped during initial mount / reconnect.
 */
export function mergeOrgWithSessions(
  orgRoots: OrgNode[],
  sessions: SessionInfo[],
  hideStopped: boolean,
  order: Record<string, string[]>,
): SidebarHierarchyNode[] {
  const sessionByName = new Map<string, SessionInfo>();
  const sessionById = new Map<string, SessionInfo>();
  for (const s of sessions) {
    if (s.name) sessionByName.set(s.name.toLowerCase(), s);
    if (s.claudeSessionId) sessionById.set(s.claudeSessionId, s);
  }

  /** Sort nodes according to stored order for a given group key */
  function applyOrder(
    nodes: SidebarHierarchyNode[],
    groupKey: string,
  ): SidebarHierarchyNode[] {
    const savedOrder = order[groupKey];
    if (!savedOrder || savedOrder.length === 0) return nodes;
    const byName = new Map<string, SidebarHierarchyNode>();
    for (const n of nodes) {
      if (n.org.name) byName.set(n.org.name.toLowerCase(), n);
    }
    const result: SidebarHierarchyNode[] = [];
    const placed = new Set<string>();
    for (const name of savedOrder) {
      if (!name) continue;
      const key = name.toLowerCase();
      const node = byName.get(key);
      if (node) {
        result.push(node);
        placed.add(key);
      }
    }
    for (const n of nodes) {
      const nKey = n.org.name?.toLowerCase();
      if (!nKey || !placed.has(nKey)) result.push(n);
    }
    return result;
  }

  function merge(node: OrgNode): SidebarHierarchyNode {
    const children = (node.children ?? []).map(merge);
    const groupKey = (node.name ?? "").toLowerCase();
    const byId = node.claudeSessionId
      ? sessionById.get(node.claudeSessionId)
      : undefined;
    return {
      org: node,
      session: byId ?? sessionByName.get(groupKey),
      children: applyOrder(children, groupKey),
    };
  }

  function hasLiveDescendant(node: SidebarHierarchyNode): boolean {
    if (node.session) return true;
    return node.children.some(hasLiveDescendant);
  }

  function prune(node: SidebarHierarchyNode): SidebarHierarchyNode | null {
    if (!hasLiveDescendant(node)) return null;
    return {
      ...node,
      children: node.children
        .map(prune)
        .filter(Boolean) as SidebarHierarchyNode[],
    };
  }

  const merged = applyOrder(orgRoots.map(merge), "__root__");
  if (!hideStopped) return merged;
  // Guard against startup race: if sessions haven't loaded yet, `prune()` would
  // remove every node because no org node can match a missing session — wiping
  // the hierarchy to zero until the next poll tick. Show unpruned tree instead.
  if (sessions.length === 0) return merged;
  return merged.map(prune).filter(Boolean) as SidebarHierarchyNode[];
}
