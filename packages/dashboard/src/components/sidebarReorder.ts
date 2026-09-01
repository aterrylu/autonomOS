/**
 * Native flat drag-reorder geometry (pure, unit-tested).
 *
 * The old native reorder drew the indicator on the hovered row's TOP edge but
 * committed with a plain splice, so a downward drag landed one slot off. Here the
 * DRAWN line and the COMMITTED slot come from the SAME computation, so they agree
 * (indicated == committed).
 */

/** Which half of the hovered row the cursor is in decides the insertion edge. */
export function dropEdgeAt(
  clientY: number,
  rect: { top: number; height: number },
): "above" | "below" {
  return clientY < rect.top + rect.height / 2 ? "above" : "below";
}

/**
 * The insertion BOUNDARY (a slot in 0..N boundary space) for a hover on row
 * `overIdx`'s `edge` — `overIdx` for "above", `overIdx + 1` for "below". This is
 * the single source of the drag GAP position: the slide-apart preview row is
 * inserted here, and `flatDropIndex`/`hierDropIndex` commit relative to the SAME
 * boundary, so the opened gap is exactly where the drop lands (indicated ==
 * committed). Distinct from the committed index, which additionally accounts for
 * the dragged row being removed first (`from < boundary ? boundary - 1 : …`).
 */
export function insertionBoundary(
  overIdx: number,
  edge: "above" | "below",
): number {
  return edge === "below" ? overIdx + 1 : overIdx;
}

/**
 * The `reorderFlat(from, to)` target index for a drag from `from`, hovering row
 * `overIdx` on its `edge`. Returns null for a no-op (dropping onto the boundary
 * the item already occupies).
 *
 * Boundary B (in the ORIGINAL array's 0..N boundary space) is `overIdx` for an
 * "above" hover, `overIdx + 1` for "below". `reorderFlat` removes `from` first,
 * so inserting at B lands at B-1 when `from < B`, else B. The line is drawn at B;
 * the item lands at B. Same math both places.
 */
export function flatDropIndex(
  from: number,
  overIdx: number,
  edge: "above" | "below",
): number | null {
  const boundary = edge === "below" ? overIdx + 1 : overIdx;
  const to = from < boundary ? boundary - 1 : boundary;
  return to === from ? null : to;
}
