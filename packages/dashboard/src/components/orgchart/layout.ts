/**
 * Org-chart layout — a small tidy-tree placer (replaces react-organizational-chart).
 *
 * Three rules the old flex layout couldn't express:
 *  - STACKED REPORTS (Terry's density pick C). A lead's LEAF reports sit in a
 *    column under it, hanging off a spine — like the sidebar — so a chart's
 *    width grows with the number of teams, not the number of agents. Reports
 *    that lead teams of their own (or are folded teams) stay side by side,
 *    since their rollup chips need headroom above the card.
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
export const H_GAP = 18;
/** Vertical gap between a manager and its reports (the elbow lives here). */
export const V_GAP = 44;
/** A stacked column sits this far right of its spine. */
export const STACK_INDENT = 24;
/** Vertical gap between cards in a stacked column. */
export const STACK_GAP = 10;
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
  /** Top-left of each card, keyed by node id (every card is CARD_W × CARD_H,
   *  so this is also each card's rect — PR 4's drop targets hit-test these). */
  pos: Map<string, Box>;
  /** Manager → report pairs, in render order. */
  edges: Array<{ from: string; to: string }>;
  /** Stacked reports: id → its column (the ids top to bottom) and the spine x.
   *  Draw its connector with `edgePath`; arrow keys walk the column. */
  stacked: Map<string, { column: string[]; spineX: number }>;
  /** The Unassigned shelf, when any root has no reports. `y` is the label's top. */
  shelf: { y: number; count: number } | null;
  width: number;
  height: number;
}

interface Measured {
  /** Width of this subtree. */
  w: number;
  /** Height of this subtree, from the card's top. */
  h: number;
  /** Width of the children's row (0 for a leaf). */
  rowW: number;
  /** Leaf reports that stack in a column, and reports laid out side by side. */
  stack: LayoutNode[];
  branches: LayoutNode[];
}

function measure(
  n: LayoutNode,
  isTeam: (n: LayoutNode) => boolean,
  out: Map<string, Measured>,
): Measured {
  // A report STACKS when it's a plain leaf: no drawn children and not a
  // folded team (a folded lead keeps its chips, which need headroom).
  const stack = n.children.filter((c) => c.children.length === 0 && !isTeam(c));
  const branches = n.children.filter((c) => !stack.includes(c));
  const parts: Array<{ w: number; h: number }> = [];
  if (stack.length > 0)
    parts.push({
      w: STACK_INDENT + CARD_W,
      h: stack.length * CARD_H + (stack.length - 1) * STACK_GAP,
    });
  for (const b of branches) {
    const m = measure(b, isTeam, out);
    parts.push({ w: m.w, h: m.h });
  }
  for (const c of stack) measure(c, isTeam, out);
  const rowW =
    parts.reduce((sum, p) => sum + p.w, 0) +
    H_GAP * Math.max(0, parts.length - 1);
  const m: Measured = {
    w: Math.max(CARD_W, rowW),
    h: parts.length
      ? CARD_H + V_GAP + Math.max(...parts.map((p) => p.h))
      : CARD_H,
    rowW,
    stack,
    branches,
  };
  out.set(n.id, m);
  return m;
}

export function layoutOrg(
  roots: LayoutNode[],
  opts: {
    /** A root that is a team even with no drawn children — a COLLAPSED lead
     *  stays in the team row instead of dropping onto the shelf. */
    isTeam?: (n: LayoutNode) => boolean;
  } = {},
): OrgLayout {
  const pos = new Map<string, Box>();
  const edges: OrgLayout["edges"] = [];
  const stacked: OrgLayout["stacked"] = new Map();
  const teamOf = (n: LayoutNode) => opts.isTeam?.(n) ?? false;
  const sizes = new Map<string, Measured>();

  // Center each parent over its children's row: first its stacked column (if
  // any), then its branches left to right.
  const place = (n: LayoutNode, x0: number, y: number) => {
    const m = sizes.get(n.id) as Measured;
    pos.set(n.id, { x: x0 + (m.w - CARD_W) / 2, y });
    let x = x0 + (m.w - m.rowW) / 2;
    const cy = y + CARD_H + V_GAP;
    if (m.stack.length > 0) {
      const column = m.stack.map((c) => c.id);
      const spineX = x + STACK_INDENT / 2;
      m.stack.forEach((c, i) => {
        pos.set(c.id, {
          x: x + STACK_INDENT,
          y: cy + i * (CARD_H + STACK_GAP),
        });
        stacked.set(c.id, { column, spineX });
        edges.push({ from: n.id, to: c.id });
      });
      x += STACK_INDENT + CARD_W + H_GAP;
    }
    for (const b of m.branches) {
      edges.push({ from: n.id, to: b.id });
      place(b, x, cy);
      x += (sizes.get(b.id) as Measured).w + H_GAP;
    }
  };

  const isTeam = (r: LayoutNode) =>
    r.children.length > 0 || (opts.isTeam?.(r) ?? false);
  const teams = roots.filter(isTeam);
  const solos = roots.filter((r) => !isTeam(r));

  let x = PAD;
  let tallest = 0;
  for (const t of teams) {
    const m = measure(t, teamOf, sizes);
    place(t, x, PAD);
    x += m.w + H_GAP * 2;
    tallest = Math.max(tallest, m.h);
  }
  let width = teams.length > 0 ? x - H_GAP * 2 + PAD : PAD * 2 + CARD_W;
  let height = teams.length > 0 ? PAD + tallest : 0;

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

  return { pos, edges, stacked, shelf, width, height: height + PAD };
}

/**
 * The connector for a manager → report edge. A stacked report hangs off its
 * column's spine: down from the manager, across to the spine, down to the
 * card's middle, then a short branch into its left edge. Everything else is
 * the elbow. Always drawn manager → report (an envelope going up reverses it).
 */
export function edgePath(layout: OrgLayout, from: string, to: string): string {
  const a = layout.pos.get(from);
  const b = layout.pos.get(to);
  if (!a || !b) return "";
  const st = layout.stacked.get(to);
  if (!st) return elbowPath(a, b);
  const x1 = a.x + CARD_W / 2;
  const y1 = a.y + CARD_H;
  const top = layout.pos.get(st.column[0]);
  const my = y1 + ((top?.y ?? b.y) - y1) / 2;
  const cy = b.y + CARD_H / 2;
  const r = Math.min(8, Math.abs(st.spineX - x1) / 2, (cy - my) / 2);
  const s = st.spineX >= x1 ? 1 : -1;
  const turn =
    Math.abs(st.spineX - x1) < 1
      ? `V${cy - r}`
      : `V${my - r}Q${x1},${my} ${x1 + s * r},${my}H${st.spineX - s * r}Q${st.spineX},${my} ${st.spineX},${my + r}V${cy - r}`;
  return `M${x1},${y1}${turn}Q${st.spineX},${cy} ${st.spineX + r},${cy}H${b.x}`;
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
