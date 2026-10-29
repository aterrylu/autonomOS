/**
 * Child process for upgrade-socket-vanish.test.ts. A real Hono app + real
 * @hono/node-ws, with an upgrade the app REFUSES after an await (as the
 * same-origin guard / auth / an unknown route do). Clients send a WebSocket
 * upgrade and RST their connection at once, so the raw socket errors during
 * node-ws's async window, while nothing but our guard listens for 'error':
 * here the RST surfaces as a `read ECONNRESET`; on a real server under load
 * the same window surfaces as `write EPIPE` from node-ws's `socket.end()`
 * (pinned deterministically in the test itself).
 *
 *   MODE=raw      node-ws wired directly (what run.ts did): crashes, exit 1
 *   MODE=guarded  wired through attachWebSockets: must stay alive
 *
 * Prints READY, then `ALIVE refused=N` once EVERY refusal has actually run
 * (counted, not slept for), and exits 0. A crash exits non-zero before ALIVE.
 */
import net from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { attachWebSockets } from "../../upgradeSockets.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODE = process.env.MODE ?? "guarded";
const CLIENTS = 25;

const app = new Hono();
const { injectWebSocket } = createNodeWebSocket({ app });
// A refusal that takes a moment, like the guard/auth path under load.
let refused = 0;
app.get("/ws/refused", async (c) => {
  await sleep(40);
  refused++;
  return c.text("refused", 403);
});

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
if (MODE === "raw") injectWebSocket(server);
else attachWebSockets(server, injectWebSocket, "test");

server.once("listening", async () => {
  const { port } = server.address() as { port: number };
  console.log("READY");
  for (let i = 0; i < CLIENTS; i++) {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(
        "GET /ws/refused HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n" +
          "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        () => s.resetAndDestroy(), // RST: the peer is gone before the refusal
      );
    });
    s.on("error", () => {});
  }
  // Wait for EVERY refusal to have run (bounded), so ALIVE can't pass a run
  // that never exercised the window. Then give node-ws's end() a beat.
  const deadline = Date.now() + 10_000;
  while (refused < CLIENTS && Date.now() < deadline) await sleep(10);
  await sleep(100);
  console.log(`ALIVE refused=${refused}`);
  server.close();
  process.exit(0);
});
