/**
 * Keep a misbehaving or vanished WebSocket client from crashing the server.
 *
 * @hono/node-ws's `upgrade` listener is async: it builds a URL from the
 * request, awaits `app.request()` (our same-origin guard, auth, routing) and,
 * for any upgrade that isn't accepted, then calls `socket.end("HTTP/1.1 …")`
 * on the RAW TCP socket. Node hands the socket over at the `upgrade` event,
 * and nothing listens for `error` on it until `ws.handleUpgrade` adds its own
 * handler. Two failures followed from that:
 *
 * - A client that disappears during the await (a killed agent's channel
 *   server mid-reconnect, a browser racing closes) makes the socket emit an
 *   `error` with no listener: `read ECONNRESET` while node-ws is still
 *   awaiting, or `write EPIPE` from its `end()`. Node escalates that to an
 *   uncaught exception: the process exited 1 and took every live agent's PTY
 *   with it (OrgChart's repro: 7 rapid kills with a dashboard open).
 * - A request line Node accepts but `new URL` rejects (e.g. `GET //[`) makes
 *   node-ws's listener reject before it answers: an unhandled rejection, and
 *   the socket is never answered or closed (a leaked descriptor per request,
 *   from any unauthenticated client).
 *
 * `attachWebSockets` is the ONE way a server gets WebSocket support here. It
 * registers our `upgrade` listener FIRST, so an `error` handler is on the
 * socket synchronously before node-ws's listener runs, and it hands node-ws a
 * view of the server whose `upgrade` listeners are wrapped: a rejection is
 * logged and the socket destroyed. Every refusal path (guard, auth, unknown
 * route) is covered at once, because they all go through that listener.
 */
import type { Duplex } from "node:stream";

/** Errors that just mean "the client went away mid-connection". */
const PEER_GONE = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED"]);

/** How often a burst of vanished clients is summarized in the log: one line
 *  per window, never one per client (any client can trigger these). */
const PEER_GONE_SUMMARY_MS = 60_000;

type UpgradeListener = (req: unknown, socket: Duplex, head: Buffer) => unknown;

interface UpgradeServer {
  on(event: "upgrade", listener: UpgradeListener): unknown;
}

function describeRequest(req: unknown): string {
  const r = req as {
    url?: string;
    socket?: { remoteAddress?: string };
  } | null;
  return `${r?.socket?.remoteAddress ?? "?"} ${JSON.stringify(r?.url ?? "")}`;
}

/** Give `server` WebSocket support, guarded. Use this instead of calling
 *  node-ws's `injectWebSocket(server)` directly. */
export function attachWebSockets<S extends UpgradeServer>(
  server: S,
  injectWebSocket: (server: S) => void,
  label: string,
): void {
  let gone = 0;
  let summary: NodeJS.Timeout | undefined;
  server.on("upgrade", (req, socket) => {
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (PEER_GONE.has(err.code ?? "")) {
        gone++;
        summary ??= setTimeout(() => {
          console.warn(
            `[ws] ${gone} client(s) on the ${label} listener went away mid-connection in the last ${PEER_GONE_SUMMARY_MS / 1000}s`,
          );
          gone = 0;
          summary = undefined;
        }, PEER_GONE_SUMMARY_MS);
        summary.unref();
        return;
      }
      console.warn(
        `[ws] WebSocket socket error on the ${label} listener (${describeRequest(req)}): ${err.message}`,
      );
    });
  });

  // node-ws only ever calls server.on("upgrade", …); wrap exactly that and
  // pass every other member through untouched.
  const wrapped = new Proxy(server, {
    get(target, key, receiver) {
      if (key !== "on") return Reflect.get(target, key, receiver);
      return (event: string, listener: UpgradeListener) => {
        if (event !== "upgrade") {
          return (target.on as (e: string, l: unknown) => unknown)(
            event,
            listener,
          );
        }
        return target.on("upgrade", (req, socket, head) => {
          const fail = (err: unknown) => {
            console.warn(
              `[ws] the ${label} listener's upgrade handler failed (${describeRequest(req)}): ${err instanceof Error ? err.message : String(err)}`,
            );
            socket.destroy();
          };
          try {
            Promise.resolve(listener(req, socket, head)).catch(fail);
          } catch (err) {
            fail(err);
          }
        });
      };
    },
  });
  injectWebSocket(wrapped);
}
