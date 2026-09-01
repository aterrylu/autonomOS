/**
 * Native hierarchy (org-tree) drag-reorder geometry (pure, unit-tested).
 *
 * Reorder is confined to a parent's own children (re-parent is out; the
 * set-manager submenu owns that). Two subtleties this module handles:
 *
 *  - Indicated == committed: same midpoint math for the drawn line and the commit
 *    (see `flatDropIndex` in sidebarReorder.ts, reused here).
 *  - Index-space translation (the nox Thread-1 bug): the rendered tree is built
 *    with hideStopped=true, so a group's rows are its LIVE siblings only — but the
 *    persisted `hierarchyOrder[gk]` keeps STOPPED names too. Splicing a live-only
 *    index into the full persisted array moves the wrong sibling whenever a parent
 *    has a stopped child. `reorderLiveInFullOrder` reorders the live entries within
 *    the full order BY NAME, leaving stopped names at their positions.
 */
import { flatDropIndex } from "./sidebarReorder";

export { dropEdgeAt } from "./sidebarReorder";

/** The live-sibling `to` index for a drag from `from`, hovering the sibling at
 *  `overIdx` on its `edge`. null = no-op. (Same geometry as the flat path.) */
export function hierDropIndex(
  from: number,
  overIdx: number,
  edge: "above" | "below",
): number | null {
  return flatDropIndex(from, overIdx, edge);
}

/**
 * Produce the new full persisted order for a group after moving the live sibling
 * at live-index `from` to live-index `to`. Non-live (stopped) names keep their
 * absolute positions; the live slots are refilled in the new live order. Robust
 * to a live sibling missing from `fullOrder` (a fresh arrival) — leftovers append.
 *
 * `liveSibs` is the group's live sibling names in render (tree) order;
 * `fullOrder` is the persisted `hierarchyOrder[gk]` (live + stopped).
 */
export function reorderLiveInFullOrder(
  fullOrder: string[],
  liveSibs: string[],
  from: number,
  to: number,
): string[] {
  const newLive = [...liveSibs];
  const [moved] = newLive.splice(from, 1);
  newLive.splice(to, 0, moved);

  const liveSet = new Set(liveSibs);
  const result: string[] = [];
  let k = 0;
  for (const name of fullOrder) {
    if (liveSet.has(name)) {
      result.push(newLive[k] ?? name);
      k += 1;
    } else {
      result.push(name);
    }
  }
  // Live siblings not present in fullOrder (fresh arrivals) — append what's left.
  while (k < newLive.length) {
    result.push(newLive[k]);
    k += 1;
  }
  return result;
}
