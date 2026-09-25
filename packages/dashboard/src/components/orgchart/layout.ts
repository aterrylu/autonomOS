/**
 * Org-chart layout — a small tidy-tree placer (replaces react-organizational-chart).
 *
 * Two rules the old flex layout couldn't express:
 *  - TEAMS SIT SIDE BY SIDE. Every root that has reports is laid out left to
 *    right; the old chart stacked every root in one tall centered column.
 *  - SOLO AGENTS GO ON A SHELF. A root with no reports isn't a "team", so it
 *    doesn't get a full-height column — it sits in one row under the teams,
 *    labelled "Unassigned".
 *
 * Pure: ids in, pixel boxes out. Rendering, theming and pruning live elsewhere,
 * so the geometry is unit-testable without a DOM.
 */

export const CARD_W = 200;
export const CARD_H = 60;
/** Horizontal gap between siblings. Teams are separated by twice this. */
export const H_GAP = 22;
/** Vertical gap between a manager and its reports (the elbow lives here). */
export const V_GAP = 58;
/** Canvas padding on every side. */
export const PAD = 32;
/** Space above the shelf row for its label. */
export const SHELF_LABEL_H = 28;

export interface LayoutNode {
  id: string;
  children: LayoutNode[];
}

export interface Box {
  x: number;
  y: number;
}

export interface OrgLayout {
  /** Top-left of each card, keyed by node id. */
  pos: Map<string, Box>;
  /** Manager → report pairs, in render order. */
  edges: Array<{ from: string; to: string }>;
  /** The Unassigned shelf, when any root has no reports. `y` is the label's top. */
  shelf: { y: number; count: number } | null;
  width: number;
  height: number;
}

/** Width a subtree needs: its own card, or its children's row, whichever is wider. */
function subtreeWidth(n: LayoutNode): number {
  if (n.children.length === 0) return CARD_W;
  const row =
    n.children.reduce((sum, c) => sum + subtreeWidth(c), 0) +
    H_GAP * (n.children.length - 1);
  return Math.max(CARD_W, row);
}

function depth(n: LayoutNode): number {
  return 1 + Math.max(0, ...n.children.map(depth));
}

export function layoutOrg(roots: LayoutNode[]): OrgLayout {
  const pos = new Map<string, Box>();
  const edges: OrgLayout["edges"] = [];

  // Center each parent over its children's row; children fill left to right.
  const place = (n: LayoutNode, x0: number, y: number) => {
    const w = subtreeWidth(n);
    pos.set(n.id, { x: x0 + (w - CARD_W) / 2, y });
    const rowW =
      n.children.reduce((sum, c) => sum + subtreeWidth(c), 0) +
      H_GAP * Math.max(0, n.children.length - 1);
    let x = x0 + (w - rowW) / 2;
    for (const c of n.children) {
      edges.push({ from: n.id, to: c.id });
      place(c, x, y + CARD_H + V_GAP);
      x += subtreeWidth(c) + H_GAP;
    }
  };

  const teams = roots.filter((r) => r.children.length > 0);
  const solos = roots.filter((r) => r.children.length === 0);

  let x = PAD;
  let maxDepth = 0;
  for (const t of teams) {
    place(t, x, PAD);
    x += subtreeWidth(t) + H_GAP * 2;
    maxDepth = Math.max(maxDepth, depth(t));
  }
  let width = teams.length > 0 ? x - H_GAP * 2 + PAD : PAD * 2 + CARD_W;
  let height =
    teams.length > 0 ? PAD + maxDepth * CARD_H + (maxDepth - 1) * V_GAP : 0;

  let shelf: OrgLayout["shelf"] = null;
  if (solos.length > 0) {
    // With no teams the shelf IS the chart — start it at the top padding.
    const labelY = teams.length > 0 ? height + V_GAP / 2 : PAD;
    const rowY = labelY + SHELF_LABEL_H;
    let sx = PAD;
    for (const s of solos) {
      pos.set(s.id, { x: sx, y: rowY });
      sx += CARD_W + H_GAP;
    }
    shelf = { y: labelY, count: solos.length };
    width = Math.max(width, sx - H_GAP + PAD);
    height = rowY + CARD_H;
  }

  return { pos, edges, shelf, width, height: height + PAD };
}

/**
 * The connector from a manager's bottom-center to a report's top-center: down,
 * across at the gap's midpoint with rounded corners, then down. A straight
 * vertical when they're aligned.
 */
export function elbowPath(from: Box, to: Box): string {
  const x1 = from.x + CARD_W / 2;
  const y1 = from.y + CARD_H;
  const x2 = to.x + CARD_W / 2;
  const y2 = to.y;
  if (Math.abs(x2 - x1) < 1) return `M${x1},${y1}V${y2}`;
  const my = y1 + (y2 - y1) / 2;
  const r = Math.min(10, Math.abs(x2 - x1) / 2, (y2 - y1) / 2);
  const s = x2 > x1 ? 1 : -1;
  return `M${x1},${y1}V${my - r}Q${x1},${my} ${x1 + s * r},${my}H${x2 - s * r}Q${x2},${my} ${x2},${my + r}V${y2}`;
}
