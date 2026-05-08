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

/** Send a pre-serialized JSON string to one client. Serialization is
 *  hoisted to the caller — see ensureListenerInstalled — so a single
 *  non-serializable payload (circular ref, BigInt, leaked Buffer, etc.)
 *  doesn't take down the whole client set in a per-iteration self-DoS. */
function safeSend(ws: WSContext, json: string): void {
  try {
    ws.send(json);
  } catch (err) {
    // Disconnect-during-broadcast is the common case (no log noise needed).
    // But if ws.send throws synchronously without a subsequent onClose, the
    // dead client stays in `clients` and gets hit on every future broadcast,
    // each silently failing — a slow leak. Drop the client here as defense
    // in depth so the set stays bounded.
    clients.delete(ws);
    if (err instanceof Error && !/closed|disconnect/i.test(err.message)) {
      console.warn(`[ws/agents] safeSend dropped a client: ${err.message}`);
    }
  }
}

/** Serialize once for the broadcast. If a payload ever fails serialization
 *  (circular ref, BigInt, etc.), drop the broadcast for THIS event only —
 *  don't iterate clients calling JSON.stringify per ws, where every client
 *  would hit the same exception and the set would self-evict. */
function safeBroadcast(payload: AgentDelta): void {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    console.error(
      `[ws/agents] non-serializable AgentDelta — dropping broadcast for type=${payload?.type ?? "unknown"}: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  for (const ws of clients) safeSend(ws, json);
}

let listenerInstalled = false;

/** Install the global event-bus subscriber. Idempotent. */
function ensureListenerInstalled(): void {
  if (listenerInstalled) return;
  onAgentDelta((event) => safeBroadcast(event));
  listenerInstalled = true;
}

export function agentsRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket(() => {
    return {
      onOpen(_event, ws) {
        ensureListenerInstalled();
        clients.add(ws);
        // Send full snapshot as the first frame. Use the same serialization
        // guard so a non-serializable Agent in the cache (shouldn't happen
        // — Agent is plain JSON — but defense in depth) drops just this
        // client rather than crashing the open handler.
        //
        // On serialization failure: drop the client AND close the socket.
        // Leaving the ws subscribed without a baseline reconcile means
        // future deltas arrive at a client with no prior state, which the
        // dashboard would either silently ignore or use to corrupt its
        // local model. Closing forces a reconnect-and-retry cycle, which
        // is the recoverable path.
        try {
          const json = JSON.stringify({
            type: "reconcile" as const,
            agents: listAgents(),
          });
          safeSend(ws, json);
        } catch (err) {
          console.error(
            `[ws/agents] reconcile serialization failed: ${err instanceof Error ? err.message : err}`,
          );
          clients.delete(ws);
          try {
            ws.close(1011, "reconcile failed");
          } catch {
            // socket already torn down
          }
        }
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
