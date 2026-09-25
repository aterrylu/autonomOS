import type { AgentTreeNode } from "@autonomos/core";

/**
 * Team rollups + collapse for the org chart.
 *
 * A ROLLUP summarizes everything under a manager — "1 needs you · 2 working" —
 * so a lead's card answers "how is my team doing?" without scanning its
 * subtree. It counts the tree AS DRAWN (after pruneExited), never hidden
 * records: a manager that reaped twenty short-lived workers must not read
 * "20 exited" forever.
 *
 * COLLAPSE folds a team into its lead's card. The rollup is computed BEFORE
 * folding, so a collapsed card still tells you who in it needs you.
 */

/** How the chart classifies one agent for counting. */
export type RollupBucket = "needsYou" | "working" | "idle" | "error" | "exited";

export interface TeamRollup {
  needsYou: number;
  working: number;
  idle: number;
  error: number;
  exited: number;
  /** Everyone under the manager (not counting the manager itself). */
  total: number;
}

const emptyRollup = (): TeamRollup => ({
  needsYou: 0,
  working: 0,
  idle: 0,
  error: 0,
  exited: 0,
  total: 0,
});

/**
 * Rollup for every node that has reports, keyed by id. `bucketOf` maps an
 * agent to its bucket (the panel supplies it from live status).
 */
export function computeRollups(
  roots: AgentTreeNode[],
  bucketOf: (node: AgentTreeNode) => RollupBucket,
): Map<string, TeamRollup> {
  const out = new Map<string, TeamRollup>();
  // Returns the subtree's counts INCLUDING `n`; stores the counts EXCLUDING it.
  const visit = (n: AgentTreeNode): TeamRollup => {
    const below = emptyRollup();
    for (const c of n.children) {
      const sub = visit(c);
      below.needsYou += sub.needsYou;
      below.working += sub.working;
      below.idle += sub.idle;
      below.error += sub.error;
      below.exited += sub.exited;
      below.total += sub.total;
    }
    if (n.children.length > 0) out.set(n.id, below);
    const self = { ...below, total: below.total + 1 };
    self[bucketOf(n)] += 1;
    return self;
  };
  for (const r of roots) visit(r);
  return out;
}

/**
 * Fold collapsed teams: a collapsed node keeps its card but loses its drawn
 * children. Ids that aren't managers (or no longer exist) are ignored, so a
 * stale persisted id is harmless. Unchanged subtrees keep their identity.
 */
export function applyCollapse(
  roots: AgentTreeNode[],
  collapsed: ReadonlySet<string>,
): AgentTreeNode[] {
  if (collapsed.size === 0) return roots;
  const visit = (n: AgentTreeNode): AgentTreeNode => {
    if (collapsed.has(n.id) && n.children.length > 0) {
      return { ...n, children: [] };
    }
    const children = n.children.map(visit);
    return children.every((c, i) => c === n.children[i])
      ? n
      : { ...n, children };
  };
  return roots.map(visit);
}
