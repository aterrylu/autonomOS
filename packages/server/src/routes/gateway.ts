/**
 * WebSocket endpoint for gateway communication.
 *
 * Two client types MAY connect here:
 *   1. Channel MCP servers (per CC session) — send { type: "register", sessionId }
 *   2. Dashboard browser — would send { type: "dashboard_connect" }
 *
 * Only (1) exists today. Nothing in packages/dashboard opens a gateway socket
 * (its single WebSocket is /ws/terminal), so the dashboard registry is empty in
 * every deployment and the message fan-out reaches nobody. The handler is kept
 * because it is the built half of a feed that has never been wired up — stated
 * here so it is not mistaken for a live observability path.
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
            // `success` means the DESTINATION ACCEPTED the message, because
            // that is now what a null return from routeMessage means (ADR-064).
            // The line is unchanged; its meaning is not. It used to report
            // routing/resolution success, so an agent was told "sent" for a
            // message injected into a dead Codex daemon or a socket mid-close.
            // Any non-null value is a sender-facing explanation, including the
            // not-yet-delivered case — which is retried automatically and must
            // NOT be re-sent (a duplicate makes a Codex agent act twice).
            //
            // UNTESTED, AND DELIBERATELY KEPT — with the reason stated so the
            // next reader can re-judge it rather than inherit it.
            //
            // No reachable throw out of `routeMessage` is currently known.
            // Review flagged one, citing the comment on the `broadcastToAllAgents`
            // this ADR deleted ("listAgents() can throw by design on a degraded
            // store, so this is reachable"). That comment was WRONG: `loadFromDisk`
            // catches both its `readdirSync` and its per-file reads and returns
            // an empty map with `lastReadFailed`, and `getAgentsDir` is a bare
            // `join`. It was itself an instance of the claim-with-nothing-behind-it
            // defect, and it propagated into a review finding — which is the
            // argument for not leaving one standing.
            //
            // The guard stays anyway because its failure mode is asymmetric.
            // Hono's node-ws wraps this handler in a SYNCHRONOUS try/catch, so a
            // rejection out of an `async onMessage` escapes it, and the server
            // registers no `unhandledRejection` handler — Node terminates the
            // PROCESS. The sender gets no `send_result` and waits out the full
            // channel-server deadline against a server that is already gone, and
            // every other agent dies with it. Cheap when wrong (a sender-facing
            // error string instead of a crash), catastrophic when absent.
            // `routeMessage`'s contract — report trouble by RETURNING a string —
            // is also exactly what makes a future throw easy to introduce here
            // without anyone noticing this call is the last boundary.
            let error: string | null;
            try {
              error = await routeMessage(msg.to, msg.message, sessionId);
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              console.error(
                `[gateway] routing from ${sessionId.slice(0, 8)} to "${msg.to}" threw:`,
                err,
              );
              error = `Message to "${msg.to}" was NOT delivered — the gateway failed while routing it (${detail}).`;
            }
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
