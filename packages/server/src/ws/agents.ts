/**
 * WebSocket endpoint for agent state deltas.
 *
 * Each connected dashboard client receives:
 *   1. On connect: `{ type: "reconcile", agents: Agent[] }` (full snapshot)
 *   2. Thereafter: per-event AgentDelta deltas as they happen
 *
 * On reconnect (network blip, server restart, laptop wake), the client sends
 * a fresh subscription and gets a new reconcile — recovers fully without
 * relying on missed-event replay or sequence numbers.
 */

import type { AgentDelta } from "@autonomos/core";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { listAgents } from "../agents/store.js";
import { onAgentDelta } from "../events/agents.js";

const clients = new Set<WSContext>();

function safeSend(ws: WSContext, payload: AgentDelta): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Client disconnected mid-broadcast; will be cleaned up by onClose.
  }
}

let listenerInstalled = false;

/** Install the global event-bus subscriber. Idempotent. */
function ensureListenerInstalled(): void {
  if (listenerInstalled) return;
  onAgentDelta((event) => {
    for (const ws of clients) safeSend(ws, event);
  });
  listenerInstalled = true;
}

export function agentsRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket(() => {
    return {
      onOpen(_event, ws) {
        ensureListenerInstalled();
        clients.add(ws);
        // Send full snapshot as the first frame.
        safeSend(ws, { type: "reconcile", agents: listAgents() });
      },

      onClose(_event, ws) {
        clients.delete(ws);
      },

      onError(event, ws) {
        console.error(
          `[ws/agents] error: ${JSON.stringify(event).slice(0, 200)}`,
        );
        clients.delete(ws);
      },
    };
  });
}

/** For testing — reset internal state. */
export function _resetForTesting(): void {
  clients.clear();
  listenerInstalled = false;
}
