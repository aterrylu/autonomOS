import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — /mcp requires auth.
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
 * The guarantee under test: /mcp is not reachable without the token, and the
 * gate is at the TRANSPORT boundary — an unauthenticated caller cannot even
 * complete `initialize`, so it never obtains the session id that later calls
 * require. Asserting only that tools/call 401s would miss a regression that
 * left session creation open.
 *
 * These assertions are deliberately about the auth boundary, not MCP protocol
 * behaviour: a valid token must still get a working session, or the fix would
 * have broken every legitimate MCP client (the channel-server each agent runs).
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

describe("/mcp requires auth", { skip: !RUN_INTEGRATION }, () => {
  let server: BootedServer;

  before(async () => {
    server = await bootServer();
  });

  after(() => {
    server?.kill();
  });

  const url = (): string => `http://127.0.0.1:${server.port}/mcp`;

  it("rejects initialize with no credential", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });
    assert.equal(
      res.status,
      401,
      `unauthenticated /mcp initialize must 401 — this is the RCE.\n${server.logs()}`,
    );
    // No session id may be handed out on the reject path: it is the capability
    // every subsequent tools/call depends on.
    assert.equal(res.headers.get("mcp-session-id"), null);
  });

  it("rejects initialize with a wrong token", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer not-the-token" },
      body: INITIALIZE_BODY,
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("mcp-session-id"), null);
  });

  it("rejects GET and DELETE without a credential too", async () => {
    // The session-resume and session-teardown methods are separate route
    // registrations; middleware must cover the whole path, not just POST.
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url(), { method, headers: MCP_HEADERS });
      assert.equal(res.status, 401, `${method} /mcp must 401`);
    }
  });

  it("accepts initialize with the real token and issues a session", async () => {
    // The other half of the contract: the fix must not break real MCP clients.
    const res = await fetch(url(), {
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
      `authenticated /mcp initialize must succeed — otherwise every agent's ` +
        `channel-server is broken.\n${server.logs()}`,
    );
    assert.ok(
      res.headers.get("mcp-session-id"),
      "authenticated initialize must return a session id",
    );
  });
});
