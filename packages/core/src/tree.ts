/**
 * Agent-tree derivation — ONE algorithm for every consumer.
 *
 * The server's `/api/agents/tree` + `get_org_chart` and the dashboard's push
 * bridge all derive the same hierarchy from the same `Agent[]`; keeping the
 * filter/link algorithm (and the canonical `AgentTreeNode` projection) here
 * means the socket-fed tree can never drift from the REST-fed one — parity
 * holds by construction, not by a mirror test.
 */

import type { Agent } from "./types/agent";
import type { AgentTreeNode } from "./types/api";

/**
 * "Live" = a running agent. The ONE definition every hierarchy view uses (the
 * org tree's default filter, the chart's rollups, the statusline's `/self`), so
 * they can't disagree. Unknown future statuses are NOT live — `AgentStatus`'s
 * contract says to treat them as exited.
 */
export function isLiveAgent(a: Pick<Agent, "status">): boolean {
  return a.status === "running";
}

/**
 * One agent's place in the hierarchy, by the SAME rules the org chart draws:
 * - `manager`: the record its `managerId` resolves to — running OR exited (the
 *   chart keeps a dead manager as a ghost over its team), `null` when unset or
 *   the record is gone (the chart makes such an agent a root).
 * - `liveReports`: direct reports that are live. Exited reports persist until
 *   deleted, so counting them would read ↓N forever after a manager reaps.
 * Returns `null` when `id` isn't a record.
 */
export function hierarchyOf(
  agents: Agent[],
  id: string,
): { self: Agent; manager: Agent | null; liveReports: Agent[] } | null {
  const self = agents.find((a) => a.id === id);
  if (!self) return null;
  const manager = self.managerId
    ? (agents.find((a) => a.id === self.managerId) ?? null)
    : null;
  const liveReports = agents.filter(
    (a) => a.managerId === self.id && isLiveAgent(a),
  );
  return { self, manager, liveReports };
}

/**
 * Build a tree from agent records.
 *
 * - `includeExited`: when false (default), only `status === "running"`
 *   agents are visible — exited AND transient states are filtered, and a
 *   filtered manager's children are promoted to roots. This preserves the
 *   original org-chart behavior; widening would be a user-visible API change.
 * - `mapNode`: projects each Agent to the consumer's node shape.
 */
export function buildTreeFromRecords<N extends { id: string; children: N[] }>(
  agents: Agent[],
  options: {
    includeExited?: boolean;
    mapNode: (a: Agent) => Omit<N, "children">;
  },
): N[] {
  const visible = options.includeExited ? agents : agents.filter(isLiveAgent);
  const byId = new Map(visible.map((a) => [a.id, a]));
  const nodeById = new Map<string, N>();
  for (const a of visible) {
    // `N extends { id; children }` makes `Omit<N,"children"> & { children }`
    // structurally identical to N; TS can't prove it through a spread, so one
    // `as N` bridges the gap — type-safe because mapNode's return IS the Omit.
    const node = { ...options.mapNode(a), children: [] as N[] } as N;
    nodeById.set(a.id, node);
  }
  const roots: N[] = [];
  for (const a of visible) {
    const node = nodeById.get(a.id);
    if (!node) continue;
    const parent =
      a.managerId && byId.has(a.managerId)
        ? nodeById.get(a.managerId)
        : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The canonical `AgentTreeNode` projection served by `/api/agents/tree` —
 * shared so the dashboard's socket-derived tree is field-identical. */
export function toAgentTreeNode(a: Agent): Omit<AgentTreeNode, "children"> {
  return {
    id: a.id,
    claudeSessionId: a.id,
    name: a.name,
    template: a.template,
    project: a.project,
    status: a.status,
    provider: a.provider,
    permissionMode: a.permissionMode,
  };
}

/** `/api/agents/tree`'s exact output for a set of records. */
export function buildAgentTreeNodes(
  agents: Agent[],
  options?: { includeExited?: boolean },
): AgentTreeNode[] {
  return buildTreeFromRecords<AgentTreeNode>(agents, {
    includeExited: options?.includeExited,
    mapNode: toAgentTreeNode,
  });
}
