/**
 * A standalone process serving ONLY the real `/ws/gateway` route on a Unix
 * socket, for tests whose oracle is "the process is still alive".
 *
 * In-process tests can't observe the V6 failure mode (security audit): a
 * rejection escaping the gateway's async onMessage terminates the SERVER
 * PROCESS, which node:test would instead catch and report as a test error. So
 * the route runs here, in a child that installs no unhandledRejection handler
 * (exactly like the bare route before run.ts's safety net), and the test
 * asserts the child survives.
 *
 * argv: <socketPath>. Prints one JSON line `{ ready, token }` once listening:
 * `token` is a per-agent credential minted for session "sess-alive", so the
 * test can prove the gateway still ACCEPTS a valid register afterwards.
 */

import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { mintAgentToken } from "../../agentCredentials.js";
import { gatewayRouter } from "../../routes/gateway.js";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("usage: gateway-fixture-server <socketPath>\n");
  process.exit(2);
}

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));
const server = createAdaptorServer({ fetch: app.fetch }) as Server;
injectWebSocket(server);
server.listen(socketPath, () => {
  const token = mintAgentToken("sess-alive");
  process.stdout.write(`${JSON.stringify({ ready: true, token })}\n`);
});
