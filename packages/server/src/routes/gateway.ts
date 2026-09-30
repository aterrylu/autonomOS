/**
 * WebSocket endpoint for gateway communication.
 *
 * One client type connects here: channel MCP servers (per agent session),
 * which send { type: "register", sessionId }. The endpoint lives on the
 * internal Unix socket (ADR-055), so nothing browser-side can reach it — a
 * dashboard message feed would need a public /ws endpoint of its own.
 *
 * Messages from channel servers are routed by the gateway URI router.
 */

import type { GatewayWsMessage } from "@autonomos/core";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { verifyAgentToken } from "../agentCredentials.js";
import { parseGatewayFrame } from "../gateway/frames.js";
import {
  getAgentList,
  type RouteMeta,
  registerSessionClient,
  routeMessage,
  unregisterSessionClient,
} from "../gateway/router.js";

export function gatewayRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket((_c) => {
    // Non-null only after a token-verified register — which is also exactly
    // the condition for unregistering on the way out.
    let sessionId: string | null = null;

    /** Drop a frame that failed validation. Logs the reason only, never the
     *  raw frame: a register frame carries the agent's credential. */
    const rejectFrame = (
      bad: Extract<ReturnType<typeof parseGatewayFrame>, { ok: false }>,
      ws: WSContext,
    ): void => {
      const who = `session=${sessionId?.slice(0, 8) ?? "unregistered"}`;
      if (bad.reason === "unknown message type") {
        // A version-skewed client (e.g. a channel server from a build whose
        // protocol has since changed). Drop, but say so, or the drift is
        // invisible until someone wonders why nothing happens.
        console.warn(
          `[gateway-ws] ignoring unknown message type ${JSON.stringify(bad.type)} (${who})`,
        );
        return;
      }
      console.warn(
        `[gateway-ws] dropped a malformed frame: ${bad.reason} (${who})`,
      );
      if (bad.type === "register") {
        // Nothing a malformed register says can be trusted, and resending the
        // same frame can't succeed. 1008 is what the channel server treats as
        // "do not reconnect".
        try {
          ws.close(1008, "invalid register frame");
        } catch {
          // already closing
        }
      } else if (bad.type === "send" && bad.requestId !== undefined) {
        // Answer it, or the sender waits out its whole deadline for a reply
        // that will never come.
        const result: GatewayWsMessage = {
          type: "send_result",
          requestId: bad.requestId,
          success: false,
          error: `Message was NOT delivered: the gateway rejected the request as malformed (${bad.reason}).`,
        };
        try {
          ws.send(JSON.stringify(result));
        } catch {
          // client disconnected
        }
      }
    };

    const handleFrame = async (raw: string, ws: WSContext): Promise<void> => {
      const parsed = parseGatewayFrame(raw);
      if (!parsed.ok) {
        rejectFrame(parsed, ws);
        return;
      }
      const msg = parsed.frame;

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
          // `meta` receives an optional sender-facing note that rides an
          // accept (manual-queue hand-off). Its `note` is only meaningful when
          // `error === null` (accepted); on a failure it stays unset.
          const meta: RouteMeta = {};
          let error: string | null;
          try {
            error = await routeMessage(msg.to, msg.message, sessionId, meta);
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
            ...(error === null && meta.note && { note: meta.note }),
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
      }
    };

    return {
      // The LAST boundary. Hono's node-ws wraps onMessage in a synchronous
      // try/catch, so a rejection out of an async handler escapes it and, with
      // no process-level handler, Node exits: one bad frame from any agent took
      // down the server and every PTY (audit V6). The schema above removes the
      // known throws; this catch makes an unknown one a log line, not a crash.
      async onMessage(event, ws) {
        try {
          const raw =
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer);
          await handleFrame(raw, ws);
        } catch (err) {
          console.error(
            `[gateway-ws] frame handler failed (session=${sessionId?.slice(0, 8) ?? "unregistered"}):`,
            err,
          );
        }
      },

      onClose(_event, ws) {
        if (sessionId) unregisterSessionClient(ws);
      },

      onError(event, ws) {
        console.error(`[gateway-ws] error (session=${sessionId}):`, event);
        if (sessionId) unregisterSessionClient(ws);
      },
    };
  });
}
