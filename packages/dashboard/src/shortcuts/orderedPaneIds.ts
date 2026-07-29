/**
 * Visual-order pane enumeration for positional shortcuts (mod+1..9).
 *
 * `api.panels` CANNOT be used for this: it flat-maps groups out of an internal
 * Map keyed by group id, i.e. group-CREATION order. Split right (creates B),
 * then split the left group again (creates C): visually A | C | B, but
 * `api.panels` yields A, B, C — mod+3 would land on the middle pane.
 *
 * `api.toJSON().grid.root` is the reliable source: a recursive branch/leaf
 * tree where a branch's children are in SPATIAL order along its orientation,
 * and a leaf's `views` are the group's tab-strip order. A depth-first walk is
 * therefore the stable, user-predictable "1st, 2nd, 3rd pane" enumeration.
 */

/** Minimal structural view of dockview's SerializedGridObject tree. */
interface GridNodeLike {
  type?: unknown;
  data?: unknown;
}

/**
 * Depth-first walk of a serialized dockview layout, returning pane ids in
 * visual order (left-to-right, top-to-bottom along each branch; tab order
 * within a group). Defensive against malformed shapes — this consumes
 * dockview output live, but the same tree shape is also persisted in
 * `dvWorkspaces[*].serialized`, which is unvalidated storage.
 */
export function orderedPaneIds(serialized: {
  grid: { root: unknown };
}): string[] {
  const out: string[] = [];
  walk(serialized?.grid?.root, out, 0);
  return out;
}

/** Bail-out ceiling. Returning [] (not a truncated list) on overflow is
 *  intended: a >32-deep grid is corrupt, and a partial enumeration would make
 *  mod+N target panes nondeterministically. actions.ts falls back to
 *  insertion order (with a warning) when this disagrees with the panel count. */
const MAX_DEPTH = 32;

function walk(node: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || !node || typeof node !== "object") return;
  const { type, data } = node as GridNodeLike;
  if (type === "branch" && Array.isArray(data)) {
    for (const child of data) walk(child, out, depth + 1);
    return;
  }
  if (type === "leaf" && data && typeof data === "object") {
    const views = (data as { views?: unknown }).views;
    if (Array.isArray(views)) {
      for (const v of views) if (typeof v === "string") out.push(v);
    }
  }
}
