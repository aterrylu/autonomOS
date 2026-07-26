/**
 * WebSocket endpoint for gateway communication.
 *
 * Two client types connect here:
 *   1. Channel MCP servers (per CC session) — send { type: "register", sessionId }
 *   2. Dashboard browser — sends { type: "dashboard_connect" }
 *
 * Messages from channel servers are routed by the gateway URI router.
 */

import type { GatewayWsMessage } from "@autonomos/core";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { verifyAgentToken } from "../agentCredentials.js";
import {
  getAgentList,
  registerDashboard,
  registerSessionClient,
  routeMessage,
  unregisterDashboard,
  unregisterSessionClient,
} from "../gateway/router.js";

export function gatewayRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket((_c) => {
    let clientType: "session" | "dashboard" | null = null;
    let sessionId: string | null = null;

    return {
      async onMessage(event, ws) {
        const raw =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);

        let msg: GatewayWsMessage;
        try {
          msg = JSON.parse(raw);
        } catch (_err) {
          console.error(
            `[gateway-ws] invalid JSON from client (type=${clientType}):`,
            raw.slice(0, 200),
          );
          return;
        }

        switch (msg.type) {
          case "register": {
            // Per-agent identity (ADR-055 PR B): verify the token maps to the
            // claimed session id BEFORE trusting it. Previously the client's
            // asserted sessionId was taken verbatim and used as the sender
            // identity for every routed message — any connected client could
            // register as any agent. Now a register with a missing/wrong token
            // is refused, so `sessionId` below (and thus routeMessage's sender)
            // is attributable. Fail-closed: an unknown session has no minted
            // token, so verifyAgentToken returns false.
            if (!verifyAgentToken(msg.sessionId, msg.agentToken)) {
              console.warn(
                `[gateway] rejected register for ${msg.sessionId.slice(0, 8)} — ` +
                  "missing or invalid per-agent token",
              );
              try {
                ws.close(1008, "invalid agent credential");
              } catch {
                // already closing
              }
              break;
            }
            clientType = "session";
            sessionId = msg.sessionId;
            registerSessionClient(msg.sessionId, ws);
            break;
          }

          case "send": {
            if (!sessionId) {
              const result: GatewayWsMessage = {
                type: "send_result",
                requestId: msg.requestId,
                success: false,
                error: "Must register before sending messages",
              };
              ws.send(JSON.stringify(result));
              break;
            }
            const error = await routeMessage(msg.to, msg.message, sessionId);
            const result: GatewayWsMessage = {
              type: "send_result",
              requestId: msg.requestId,
              success: error === null,
              ...(error && { error }),
            };
            try {
              ws.send(JSON.stringify(result));
            } catch {
              // client disconnected before we could send result
            }
            break;
          }

          case "list_agents_request": {
            const agents = await getAgentList();
            const response: GatewayWsMessage = {
              type: "list_agents_response",
              requestId: msg.requestId,
              agents,
            };
            ws.send(JSON.stringify(response));
            break;
          }

          case "dashboard_connect": {
            clientType = "dashboard";
            registerDashboard(ws);
            break;
          }
        }
      },

      onClose(_event, ws) {
        cleanup(ws, clientType);
      },

      onError(event, ws) {
        console.error(`[gateway-ws] error (type=${clientType}):`, event);
        cleanup(ws, clientType);
      },
    };
  });
}

function cleanup(
  ws: WSContext,
  clientType: "session" | "dashboard" | null,
): void {
  if (clientType === "session") {
    unregisterSessionClient(ws);
  } else if (clientType === "dashboard") {
    unregisterDashboard(ws);
  }
}
