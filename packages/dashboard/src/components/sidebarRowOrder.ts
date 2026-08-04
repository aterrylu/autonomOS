import type { SidebarHierarchyNode } from "./mergeOrgWithSessions";

/**
 * The sidebar's RENDERED agent-row order — the single source the mod+digit
 * shortcuts and their hold-badges both derive from (ADR-066). The Sidebar
 * publishes this into the store from the same memoized inputs it renders, so
 * "the row with badge N" and "what mod+N switches to" cannot disagree.
 *
 * Hierarchy mode mirrors the JSX exactly: depth-first, parent row before
 * children, children of a COLLAPSED group skipped (not on screen = not
 * numbered), and "stopped" placeholder rows (no live session) skipped — they
 * are not clickable, so they must not consume a digit.
 */
export function flattenHierarchyRows(
  nodes: SidebarHierarchyNode[],
  collapsedGroups: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const walk = (list: SidebarHierarchyNode[]) => {
    for (const node of list) {
      if (node.session) out.push(node.session.id);
      const name = (node.org.name ?? "").toLowerCase();
      if (node.children.length > 0 && !collapsedGroups.has(name)) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * Which digit chord switches to the row at `index` (0-based, rendered order).
 * Positional 1..9; rows beyond the 9th are unreachable by digit (null).
 * Null for a lone row — a single agent needs no hint.
 */
export function digitForRow(index: number, count: number): number | null {
  if (count < 2) return null;
  if (index < 0 || index >= count || index >= 9) return null;
  return index + 1;
}
