import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  RUN_INTEGRATION,
  socketRequest,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — /mcp is off the network,
 * and still requires auth where it does live.
 *
 * Regression suite for an unauthenticated remote-code-execution hole. The auth
 * middleware was mounted on "/api/*" and "/ws/*" only, and `/mcp` — the
 * Streamable-HTTP transport exposing create_agent / kill_agent / set_manager —
 * matched neither prefix and had no internal check of its own. Anything that
 * could reach the port could open an MCP session and spawn an agent with
 * `permissionMode: "bypass"` and an arbitrary workingDirectory + prompt. The
 * server also bound all interfaces by default, so "anything that could reach
 * the port" meant any host on the network.
 *
 * ADR-054 closed that with the token. ADR-055 then moved `/mcp` off TCP
 * entirely onto the internal Unix socket, so this suite now asserts TWO
 * layers — and the outer one is the reason the inner one is no longer the only
 * thing standing between the network and agent spawning:
 *
 *   1. PUBLIC LISTENER — /mcp is not served at all. Not "served but 401": the
 *      route does not exist there, so no credential, malformed or otherwise,
 *      can reach the transport over the network.
 *   2. INTERNAL SOCKET — /mcp is served, and STILL requires the token. Kept as
 *      defense in depth: the socket answers "who may connect" (same-user,
 *      on-box), the token still answers "prove it". A regression that dropped
 *      the middleware would leave any local process able to spawn agents.
 *
 * The auth assertions target the TRANSPORT boundary: an unauthenticated caller
 * must not complete `initialize`, so it never obtains the session id later
 * calls require. Asserting only that tools/call 401s would miss a regression
 * that left session creation open.
 *
 * And the other half of the contract: a valid token over the socket must still
 * get a working session, or every agent's channel-server is broken.
 */

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-auth-test", version: "0" },
  },
});

describe("/mcp is socket-only and authenticated", {
  skip: !RUN_INTEGRATION,
}, () => {
  let server: BootedServer;

  before(async () => {
    server = await bootServer();
  });

  after(() => {
    server?.kill();
  });

  const publicUrl = (): string => `http://127.0.0.1:${server.port}/mcp`;

  // ── Layer 1: not on the network at all ─────────────────────────────

  it("does not serve /mcp on the public listener, even with a valid token", async () => {
    const res = await fetch(publicUrl(), {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${server.token}`,
      },
      body: INITIALIZE_BODY,
    });
    assert.notEqual(
      res.status,
      200,
      `/mcp must NOT be reachable over TCP — that is the network exposure ` +
        `ADR-055 removes.\n${server.logs()}`,
    );
    // No session id may be handed out over the network on any path: it is the
    // capability every subsequent tools/call depends on.
    assert.equal(res.headers.get("mcp-session-id"), null);
  });

  it("does not serve /mcp on the public listener for GET or DELETE either", async () => {
    // Session-resume and session-teardown are separate route registrations;
    // all of them must be absent from the public app, not just POST.
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(publicUrl(), { method, headers: MCP_HEADERS });
      assert.notEqual(
        res.status,
        200,
        `${method} /mcp must not succeed on TCP`,
      );
      assert.equal(res.headers.get("mcp-session-id"), null);
    }
  });

  // ── Layer 2: on the socket, still gated ────────────────────────────

  it("rejects initialize over the socket with no credential", async () => {
    const res = await socketRequest(server, "/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });
    assert.equal(
      res.status,
      401,
      `unauthenticated /mcp initialize must 401 even on the socket — the ` +
        `socket restricts WHO can connect, the token still proves it.\n${server.logs()}`,
    );
    assert.equal(res.headers["mcp-session-id"], undefined);
  });

  it("rejects initialize over the socket with a wrong token", async () => {
    const res = await socketRequest(server, "/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer not-the-token" },
      body: INITIALIZE_BODY,
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers["mcp-session-id"], undefined);
  });

  it("rejects GET and DELETE over the socket without a credential", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await socketRequest(server, "/mcp", {
        method,
        headers: MCP_HEADERS,
      });
      assert.equal(res.status, 401, `${method} /mcp must 401 on the socket`);
    }
  });

  it("accepts initialize over the socket with the real token and issues a session", async () => {
    const res = await socketRequest(server, "/mcp", {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${server.token}`,
      },
      body: INITIALIZE_BODY,
    });
    assert.equal(
      res.status,
      200,
      `authenticated /mcp initialize must succeed over the socket — ` +
        `otherwise every agent's channel-server is broken.\n${server.logs()}`,
    );
    assert.ok(
      res.headers["mcp-session-id"],
      "authenticated initialize must return a session id",
    );
  });
});
