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
import type { WSContext } from "hono/ws";
import WebSocket from "ws";
import {
  _resetAgentCredentialsForTesting,
  mintAgentToken,
} from "../agentCredentials.js";
import {
  isSessionClientRegistered,
  registerSessionClient,
  routeMessage,
  unregisterSessionClient,
} from "../gateway/router.js";
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

/**
 * The Claude Code delivery guard, against a REAL `WSContext` — not a literal.
 *
 * Raised in review (nox-0x on #299): the guard is the entire Claude Code half of
 * the delivery ack, and its only coverage was `{ readyState: 2, send }`, which
 * cannot distinguish a LIVE getter from a value captured at construction. If
 * hono assigned `this.readyState = init.readyState` in the constructor, the
 * check would read `1` forever, the CLOSING window would be exactly as
 * unguarded as before this PR, and the object-literal test would stay green.
 *
 * Settled empirically first (hono 4.12.5 / @hono/node-ws 1.3.0: a real context
 * reports 1 while open and 3 after close), then pinned here so a dependency bump
 * that turns it into a snapshot fails instead of silently disarming the guard.
 *
 * Registering AFTER the close is deliberate: it is what makes this
 * deterministic. A socket closed while registered races the server's own
 * `onClose` → `unregisterSessionClient`, after which routing takes the
 * "not found" branch and never reaches the guard at all — green for the wrong
 * reason. Registering a known-closed context reproduces the exact state the
 * guard exists for (present in the registry, incapable of carrying data)
 * without depending on which callback wins.
 */
describe("Claude Code delivery guard — real WSContext, not a literal", () => {
  let srv: Server;
  let ctx: WSContext | null = null;
  let client: WebSocket;

  before(async () => {
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.get(
      "/",
      upgradeWebSocket(() => ({
        onOpen(_e: Event, ws: WSContext) {
          ctx = ws;
        },
      })),
    );
    srv = createAdaptorServer({ fetch: app.fetch }) as Server;
    injectWebSocket(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as { port: number };
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => client.addEventListener("open", () => r()));
  });

  after(() => {
    try {
      client?.close();
    } catch {
      // already closing
    }
    srv?.close();
  });

  it("reports a real OPEN context as open — the guard must not false-negative", () => {
    assert.ok(ctx, "the server must have captured a real WSContext");
    assert.equal(
      (ctx as WSContext).readyState,
      1,
      "a live socket must read OPEN, or the guard would refuse healthy delivery",
    );
  });

  it("refuses delivery through a real context whose socket has closed", async () => {
    const target = ctx as WSContext;
    target.close();
    // Wait for the real transition rather than guessing a sleep. If readyState
    // were a construct-time snapshot this never leaves 1 and the test times
    // out here — which is itself the finding.
    const deadline = Date.now() + 3000;
    while (target.readyState === 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.notEqual(
      target.readyState,
      1,
      "readyState must be a LIVE delegate; a snapshot would leave the guard inert",
    );

    registerSessionClient("sess-closed-real", target);
    try {
      const err = await routeMessage(
        "agent://sess-closed-real",
        "does this get claimed as delivered?",
        "sess-sender-real",
      );
      assert.ok(err, "must NOT report success through a dead socket");
      assert.match(err, /not delivered/);
    } finally {
      unregisterSessionClient(target);
    }
  });
});
