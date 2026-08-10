/**
 * Push bridge — connects the /ws/agents socket to the poll/store layer.
 *
 * While the socket is live it OWNS the three highest-frequency resources
 * (agents 5s, tree 5s, statuses 3s): their polls are suspended and every
 * socket frame is translated into the exact same apply/commit paths the
 * polls fed, so no component knows the source changed. When the socket
 * drops, the polls resume with an immediate catch-up refresh — a flaky
 * network degrades to exactly the pre-push dashboard, never below it.
 *
 * The tree is derived client-side with the same algorithm as the server's
 * buildAgentTree (routes/agents.ts /tree): running-only filter, children
 * grouped under a visible manager, orphans promoted to roots. The reconcile
 * frame carries the same listAgents() array the REST endpoints serve, so
 * order parity holds without sorting.
 */

import type { Agent, AgentStatusMap, AgentTreeNode } from "@autonomos/core";
import { agentsSocket } from "./api/agentsSocket";
import { agentsPoll, statusPoll, treePoll } from "./api/polls";
import { applyAgentsSnapshot, applyStatusSnapshot } from "./store";

/** Mirror of the server's buildAgentTree with the /tree route's mapNode. */
export function buildTreeFromAgents(agents: Agent[]): AgentTreeNode[] {
  const visible = agents.filter((a) => a.status === "running");
  const byId = new Map(visible.map((a) => [a.id, a]));
  const nodeById = new Map<string, AgentTreeNode>();
  for (const a of visible) {
    nodeById.set(a.id, {
      id: a.id,
      claudeSessionId: a.id,
      name: a.name,
      template: a.template,
      project: a.project,
      status: a.status,
      provider: a.provider,
      permissionMode: a.permissionMode,
      children: [],
    });
  }
  const roots: AgentTreeNode[] = [];
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

let stopBridge: (() => void) | null = null;

/** Start the bridge (idempotent). Returns a stop function that unsuspends
 * the polls and closes the socket subscription. */
export function startPushBridge(): () => void {
  if (stopBridge) return stopBridge;

  let live = false;

  const setLive = (next: boolean) => {
    if (live === next) return;
    live = next;
    agentsPoll.setSuspended(next);
    treePoll.setSuspended(next);
    statusPoll.setSuspended(next);
  };

  const onSnapshot = () => {
    const snap = agentsSocket.getSnapshot();
    // "Live" requires a reconcile, not just an open socket — until the
    // baseline lands, polls keep the dashboard current.
    setLive(snap.connected && snap.agents !== null);
    if (!live || !snap.agents) return;

    const agents = Array.from(snap.agents.values());
    applyAgentsSnapshot(agents);
    agentsPoll.inject(agents);
    treePoll.inject(buildTreeFromAgents(agents));

    const map: AgentStatusMap = {};
    for (const [id, v] of snap.statuses) {
      map[id] = { status: v.state, unread: v.unread };
    }
    applyStatusSnapshot(map);
    statusPoll.inject(map);
  };

  const unsubscribe = agentsSocket.subscribe(onSnapshot);
  // Apply whatever the socket already has (subscribe doesn't replay).
  onSnapshot();

  stopBridge = () => {
    unsubscribe();
    setLive(false);
    stopBridge = null;
  };
  return stopBridge;
}
