/**
 * Keep a vanished WebSocket client from crashing the server.
 *
 * @hono/node-ws's `upgrade` listener is async: it awaits `app.request()` (our
 * same-origin guard, auth, routing) and, for any upgrade that isn't accepted,
 * then calls `socket.end("HTTP/1.1 …")` on the RAW TCP socket. Node hands the
 * socket over at the `upgrade` event, and nothing listens for `error` on it
 * until `ws.handleUpgrade` adds its own handler. A client that disappears
 * during that await (a killed agent's channel server mid-reconnect, a browser
 * racing closes) turns `end()` into an EPIPE `error` with no listener, which
 * Node escalates to an uncaught exception: the process exited 1 and took
 * every live agent's PTY with it (OrgChart's repro: 7 rapid kills with a
 * dashboard open).
 *
 * `attachWebSockets` is the ONE way a server gets WebSocket support here: it
 * registers our `upgrade` listener FIRST, so an `error` handler is on the
 * socket synchronously, before node-ws's listener runs (listeners run in
 * registration order), and only then hands the server to node-ws. It covers
 * every refusal path at once (guard, auth, unknown route), because they all
 * end through that same `socket.end()`.
 */
import type { Duplex } from "node:stream";

/** Errors that just mean "the client went away mid-handshake". */
const PEER_GONE = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED"]);

interface UpgradeServer {
  on(
    event: "upgrade",
    listener: (req: unknown, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export function guardUpgradeSockets(
  server: UpgradeServer,
  label: string,
): void {
  server.on("upgrade", (_req, socket) => {
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (PEER_GONE.has(err.code ?? "")) return;
      console.warn(
        `[ws] upgrade socket error on the ${label} listener: ${err.message}`,
      );
    });
  });
}

/** Give `server` WebSocket support, guarded. Use this instead of calling
 *  node-ws's `injectWebSocket(server)` directly. */
export function attachWebSockets<S extends UpgradeServer>(
  server: S,
  injectWebSocket: (server: S) => void,
  label: string,
): void {
  guardUpgradeSockets(server, label);
  injectWebSocket(server);
}
