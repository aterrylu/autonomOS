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
 * The tree comes from the SAME algorithm the server serves on
 * `/api/agents/tree` (`buildAgentTreeNodes` in @autonomos/core) — parity by
 * construction, not by a mirror kept in sync by hand.
 */

import {
  type Agent,
  type AgentStatusMap,
  buildAgentTreeNodes,
} from "@autonomos/core";
import { agentsSocket } from "./api/agentsSocket";
import { agentsPoll, statusPoll, treePoll } from "./api/polls";
import { applyAgentsSnapshot, applyStatusSnapshot } from "./store";

let stopBridge: (() => void) | null = null;

/** Start the bridge (idempotent). Returns a stop function that unsuspends
 * the polls and closes the socket subscription. */
export function startPushBridge(): () => void {
  if (stopBridge) return stopBridge;

  let live = false;
  // agent.status deltas commit a new statuses map but keep the agents map by
  // REFERENCE — and status deltas are the high-frequency frame (~2 per tool
  // call per agent). Skipping the agents/tree re-derive + re-inject (whose
  // commit equality is a full JSON.stringify of a fleet-sized payload) on
  // those frames is what keeps a busy fleet from turning the push channel
  // into a main-thread stringify loop (see ADR-072 for why we care).
  let lastAgents: Map<string, Agent> | null = null;

  const setLive = (next: boolean) => {
    if (live === next) return;
    live = next;
    agentsPoll.setSuspended(next);
    treePoll.setSuspended(next);
    statusPoll.setSuspended(next);
    if (!next) lastAgents = null;
  };

  const onSnapshot = () => {
    const snap = agentsSocket.getSnapshot();
    // "Live" requires a reconcile, not just an open socket — until the
    // baseline lands, polls keep the dashboard current.
    setLive(snap.connected && snap.agents !== null);
    if (!live || !snap.agents) return;

    if (snap.agents !== lastAgents) {
      lastAgents = snap.agents;
      const agents = Array.from(snap.agents.values());
      applyAgentsSnapshot(agents);
      agentsPoll.inject(agents);
      treePoll.inject(buildAgentTreeNodes(agents));
    }

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
