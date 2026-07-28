import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import WebSocket from "ws";
import {
  _resetAgentCredentialsForTesting,
  mintAgentToken,
} from "../agentCredentials.js";
import { isSessionClientRegistered } from "../gateway/router.js";
import { gatewayRouter } from "../routes/gateway.js";

/**
 * Gateway send-DELIVERY over the real ws+unix socket transport (ADR-055 PR B).
 *
 * The gap this closes: gateway-router.test.ts routes with MOCK WSContexts, and
 * provider-url-token asserts the ws+unix URL string — but nothing exercised a
 * real `ws+unix://` client registering with its per-agent token AND a routed
 * message actually ARRIVING at the peer. That is the headline of PR B part 1
 * (gateway on the socket) and exactly where a "connects fine, registers fine,
 * messages silently don't deliver" bug would hide. This is the gateway analogue
 * of PR A's "do hooks land" — a message that ARRIVES, not just "no error".
 *
 * In-process (not two spawned agents) so the server's credential map is the one
 * the clients' tokens were minted into — a child process can't share it.
 * Mounts only the gateway route; the global-token /ws/* auth layer is covered
 * separately by mcp-auth.test.ts.
 */

const SOCK_DIR = mkdtempSync(join(tmpdir(), "aos-gw-deliver-"));
const SOCKET = join(SOCK_DIR, "control.sock");
const GATEWAY_URL = `ws+unix://${SOCKET}:/ws/gateway`;

let server: Server;

/** Open a ws+unix client and register as `sessionId` with `agentToken`. */
function connectAndRegister(
  sessionId: string,
  agentToken: string | undefined,
): { ws: WebSocket; received: string[]; closed: Promise<number> } {
  const ws = new WebSocket(GATEWAY_URL);
  const received: string[] = [];
  ws.addEventListener("message", (ev) => {
    received.push(typeof ev.data === "string" ? ev.data : ev.data.toString());
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (ev) => resolve(ev.code));
  });
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "register", sessionId, agentToken }));
  });
  return { ws, received, closed };
}

/** Poll a predicate until true or timeout. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

describe("gateway send-delivery over ws+unix", () => {
  before(async () => {
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    // No requireAuth here on purpose — this test targets the per-agent register
    // verification + delivery. The global-token layer is mcp-auth's job.
    app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));
    server = createAdaptorServer({ fetch: app.fetch }) as Server;
    injectWebSocket(server);
    await new Promise<void>((resolve) => server.listen(SOCKET, resolve));
  });

  after(() => {
    _resetAgentCredentialsForTesting();
    server?.close();
    rmSync(SOCK_DIR, { recursive: true, force: true });
  });

  it("delivers a message A→B over the real socket, both registered with valid tokens", async () => {
    const tokenA = mintAgentToken("sess-A");
    const tokenB = mintAgentToken("sess-B");

    const a = connectAndRegister("sess-A", tokenA);
    const b = connectAndRegister("sess-B", tokenB);

    // Both must register (the transport-level accept, not just the unit path).
    const bothUp = await waitUntil(
      () =>
        isSessionClientRegistered("sess-A") &&
        isSessionClientRegistered("sess-B"),
    );
    assert.ok(bothUp, "both clients must register over ws+unix");

    // A sends to B; assert B RECEIVES the marker (delivery, not just no-error).
    const MARKER = "DELIVERY_MARKER_9c2f";
    a.ws.send(
      JSON.stringify({
        type: "send",
        to: "agent://sess-B",
        message: MARKER,
        requestId: "req-1",
      }),
    );

    const arrived = await waitUntil(() =>
      b.received.some((m) => m.includes(MARKER)),
    );
    assert.ok(
      arrived,
      `B must RECEIVE the marker over the socket. B got: ${JSON.stringify(b.received)}`,
    );

    // And A must get a success ack for the send.
    const acked = await waitUntil(() =>
      a.received.some(
        (m) => m.includes("send_result") && m.includes('"success":true'),
      ),
    );
    assert.ok(acked, "A must get send_result success");

    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
  });

  it("rejects a register with a WRONG token — 1008 close, not registered", async () => {
    mintAgentToken("sess-C"); // real token exists, client presents a wrong one
    const c = connectAndRegister("sess-C", "wrong-token");

    const code = await c.closed; // gateway should ws.close(1008, ...)
    assert.equal(code, 1008, "wrong-token register must be closed with 1008");
    assert.equal(
      isSessionClientRegistered("sess-C"),
      false,
      "a rejected client must NOT be in the session registry",
    );
  });

  it("rejects a register with NO token — 1008 close, not registered", async () => {
    mintAgentToken("sess-D");
    const d = connectAndRegister("sess-D", undefined);

    const code = await d.closed;
    assert.equal(code, 1008, "tokenless register must be closed with 1008");
    assert.equal(isSessionClientRegistered("sess-D"), false);
  });
});

/**
 * The `?token=` query MUST survive the ws+unix colon-split (nox review, #293).
 *
 * The gateway also sits behind the global-token /ws/* auth. The channel-server
 * appends `?token=<global>` to the ws+unix URL, and `ws@^8.x` computes
 * `opts.path = pathname + search` BEFORE splitting the socket path off on the
 * first ':'. If a future `ws` reordered those steps the query would be lost and
 * every agent would fail auth — but nothing in the repo would fail; it was only
 * covered by an ADR note about a dependency's internals + a manual live check.
 * This pins it: assert the server actually SEES the query token over ws+unix.
 */
describe("gateway ws+unix preserves the ?token= query", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-gw-token-"));
  const sock = join(dir, "control.sock");
  const url = (token?: string) =>
    `ws+unix://${sock}:/ws/gateway${token ? `?token=${token}` : ""}`;
  const GOOD = "good-global-token";
  let srv: Server;

  // Mirrors the query-token branch of run.ts's requireAuth — the ONLY branch a
  // ws+unix upgrade can exercise (no cookie/header on a raw ws handshake).
  const requireQueryToken: MiddlewareHandler = async (c, next) => {
    if (c.req.query("token") === GOOD) return next();
    return c.json({ error: "Unauthorized" }, 401);
  };

  before(async () => {
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.use("/ws/gateway", requireQueryToken);
    app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));
    srv = createAdaptorServer({ fetch: app.fetch }) as Server;
    injectWebSocket(srv);
    await new Promise<void>((r) => srv.listen(sock, r));
  });

  after(() => {
    _resetAgentCredentialsForTesting();
    srv?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Did the ws open (auth passed) or close before opening (auth rejected)? */
  function openOutcome(u: string): Promise<"open" | "closed"> {
    const ws = new WebSocket(u);
    return new Promise((resolve) => {
      ws.addEventListener("open", () => {
        ws.close();
        resolve("open");
      });
      ws.addEventListener("close", () => resolve("closed"));
      ws.addEventListener("error", () => {});
      setTimeout(() => resolve("closed"), 2000);
    });
  }

  it("accepts the upgrade when ?token= is the valid global token", async () => {
    // If the query survived the colon-split, requireQueryToken sees GOOD and the
    // upgrade completes.
    assert.equal(await openOutcome(url(GOOD)), "open");
  });

  it("rejects the upgrade when ?token= is missing", async () => {
    assert.equal(await openOutcome(url(undefined)), "closed");
  });

  it("rejects the upgrade when ?token= is wrong", async () => {
    assert.equal(await openOutcome(url("wrong")), "closed");
  });
});
