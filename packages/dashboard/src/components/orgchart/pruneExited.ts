import type { AgentTreeNode } from "@autonomos/core";

/**
 * Decide which exited agents the org chart draws.
 *
 * The chart fetches the tree WITH exited agents (`includeExited=true`) so a
 * crashed manager keeps its place and its reports stay under it — the core
 * default filters exited records and promotes their reports to roots, which is
 * what scattered a team across the top level. But drawing EVERY exited record
 * would bury the chart: a manager that reaps short-lived workers accumulates
 * dozens of them.
 *
 * Rule: an exited agent is STRUCTURAL — always drawn, as a ghost — when its
 * subtree still contains a running agent (it's holding a live team together).
 * Every other exited agent is hidden unless the viewer asks to see them. Because
 * a hidden node never has a running descendant, hiding it can never orphan a
 * running agent: pruning removes whole dead subtrees, never promotes.
 */
export function pruneExited(
  roots: AgentTreeNode[],
  showAllExited: boolean,
): { roots: AgentTreeNode[]; hiddenExited: number } {
  let hiddenExited = 0;

  const visit = (n: AgentTreeNode): AgentTreeNode | null => {
    // Children first: each dropped child has already counted itself (and its
    // own dropped subtree) by the time we decide about `n`.
    const children = n.children
      .map(visit)
      .filter((c): c is AgentTreeNode => c !== null);
    const keep =
      showAllExited ||
      n.status === "running" ||
      children.some((c) => hasRunning(c));
    if (!keep) {
      // Not kept ⇒ `n` isn't running and no child survived, so it's the one
      // uncounted node left in this subtree.
      hiddenExited += 1;
      return null;
    }
    return children.length === n.children.length &&
      children.every((c, i) => c === n.children[i])
      ? n
      : { ...n, children };
  };

  const out = roots.map(visit).filter((r): r is AgentTreeNode => r !== null);
  return { roots: out, hiddenExited };
}

function hasRunning(n: AgentTreeNode): boolean {
  return n.status === "running" || n.children.some(hasRunning);
}
