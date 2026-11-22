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
/** Left→right: horizontal gap between a manager's column and its reports'. */
export const COL_GAP = 56;
/** Left→right: vertical gap between sibling teams, room for a lead's rollup
 *  chips (they sit 19px above its card). Plain siblings use STACK_GAP. */
export const TEAM_GAP = 28;
/** Canvas padding on every side. */
export const PAD = 32;
/** Space above the shelf row for its label. */
export const SHELF_LABEL_H = 28;

/** Which way the chart grows: top→down (teams side by side) or left→right
 *  (the root on the left, each level a column to its right). */
export type OrgDirection = "td" | "lr";

export interface LayoutNode {
  id: string;
  children: LayoutNode[];
}

export interface Box {
  x: number;
  y: number;
}

export interface OrgLayout {
  direction: OrgDirection;
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
  for (const b of branches) parts.push(measure(b, isTeam, out));
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
    direction?: OrgDirection;
  } = {},
): OrgLayout {
  if (opts.direction === "lr") return layoutLeftRight(roots, opts.isTeam);
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

  return {
    direction: "td",
    pos,
    edges,
    stacked,
    shelf,
    width,
    height: height + PAD,
  };
}

/**
 * Left→right: the root on the left, each level a column to its right, and a
 * manager centered on its reports. Reports already stack top to bottom here,
 * so there are no stacked columns. Teams (roots with reports) run down the
 * page; solo agents sit on the same "Unassigned" shelf underneath.
 */
function layoutLeftRight(
  roots: LayoutNode[],
  isTeamOpt?: (n: LayoutNode) => boolean,
): OrgLayout {
  const pos = new Map<string, Box>();
  const edges: OrgLayout["edges"] = [];
  const isLead = (n: LayoutNode) =>
    n.children.length > 0 || (isTeamOpt?.(n) ?? false);
  const gap = (a: LayoutNode, b: LayoutNode) =>
    isLead(a) || isLead(b) ? TEAM_GAP : STACK_GAP;
  const band = new Map<string, number>();
  const measure = (n: LayoutNode): number => {
    let h = 0;
    n.children.forEach((c, i) => {
      if (i > 0) h += gap(n.children[i - 1], c);
      h += measure(c);
    });
    const out = Math.max(CARD_H, h);
    band.set(n.id, out);
    return out;
  };
  let deepest = 0;
  const place = (n: LayoutNode, depth: number, y0: number) => {
    deepest = Math.max(deepest, depth);
    const x = PAD + depth * (CARD_W + COL_GAP);
    if (n.children.length === 0) {
      pos.set(n.id, { x, y: y0 });
      return;
    }
    let y = y0;
    n.children.forEach((c, i) => {
      if (i > 0) y += gap(n.children[i - 1], c);
      edges.push({ from: n.id, to: c.id });
      place(c, depth + 1, y);
      y += band.get(c.id) as number;
    });
    const first = pos.get(n.children[0].id) as Box;
    const last = pos.get(n.children[n.children.length - 1].id) as Box;
    pos.set(n.id, { x, y: (first.y + last.y) / 2 });
  };

  const teams = roots.filter(isLead);
  const solos = roots.filter((r) => !isLead(r));
  let y = PAD;
  for (const t of teams) {
    const h = measure(t);
    place(t, 0, y);
    y += h + TEAM_GAP * 2;
  }
  let width =
    teams.length > 0
      ? PAD * 2 + (deepest + 1) * CARD_W + deepest * COL_GAP
      : PAD * 2 + CARD_W;
  let height = teams.length > 0 ? y - TEAM_GAP * 2 : 0;

  let shelf: OrgLayout["shelf"] = null;
  if (solos.length > 0) {
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
  return {
    direction: "lr",
    pos,
    edges,
    stacked: new Map(),
    shelf,
    width,
    height: height + PAD,
  };
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
  if (layout.direction === "lr") return sidewaysPath(a, b);
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
 * The dotted arc for a message that doesn't follow a manager edge (peers, or
 * across teams). It bows above the cards when they sit side by side, and to
 * their right when they share a column (always in left-right, and in a
 * top-down stack), where an arc over their tops would cut through the cards
 * between them.
 */
export function arcPath(layout: OrgLayout, from: Box, to: Box): string {
  // A top-down stacked column is also one x: bow sideways there too.
  if (layout.direction === "lr" || Math.abs(from.x - to.x) < 1) {
    const x1 = from.x + CARD_W;
    const x2 = to.x + CARD_W;
    const y1 = from.y + CARD_H / 2;
    const y2 = to.y + CARD_H / 2;
    return `M${x1},${y1}Q${Math.max(x1, x2) + 46},${(y1 + y2) / 2} ${x2},${y2}`;
  }
  const x1 = from.x + CARD_W / 2;
  const x2 = to.x + CARD_W / 2;
  return `M${x1},${from.y}Q${(x1 + x2) / 2},${Math.min(from.y, to.y) - 46} ${x2},${to.y}`;
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

/**
 * Left→right connector: from a manager's right-middle to a report's
 * left-middle, across to the gap's midpoint, then down (or up) with rounded
 * corners. A straight line when they're level.
 */
function sidewaysPath(from: Box, to: Box): string {
  const x1 = from.x + CARD_W;
  const y1 = from.y + CARD_H / 2;
  const x2 = to.x;
  const y2 = to.y + CARD_H / 2;
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1}H${x2}`;
  const mx = x1 + (x2 - x1) / 2;
  const r = Math.min(10, Math.abs(y2 - y1) / 2, (x2 - x1) / 2);
  const s = y2 > y1 ? 1 : -1;
  return `M${x1},${y1}H${mx - r}Q${mx},${y1} ${mx},${y1 + s * r}V${y2 - s * r}Q${mx},${y2} ${mx + r},${y2}H${x2}`;
}
