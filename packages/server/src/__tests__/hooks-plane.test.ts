import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  authedJson,
  type BootedServer,
  bootServer,
  controlSocketPath,
  RUN_INTEGRATION,
  socketRequest,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — the /api/hooks trust
 * boundary (ADR-055).
 *
 * `POST /api/hooks/:sessionId` was the residual ADR-054 knowingly left open:
 * it accepted UNAUTHENTICATED writes from anywhere on the network, on a server
 * that binds all interfaces by default. A hook post drives agent status and
 * the notification panel, so anyone who could reach the port could forge an
 * agent's status or inject notifications into the operator's dashboard.
 *
 * `/api/hooks` is really two surfaces sharing a prefix, and they belong on
 * opposite sides of the boundary:
 *
 *   INGEST (`POST /:sessionId`) — written by spawned agents → internal socket.
 *   READ (everything else) — read by the dashboard, a browser → public + token.
 *
 * Getting this split wrong is silent in both directions, which is why it is
 * pinned here: hook curls are `-sf >/dev/null 2>&1` so a broken ingest path
 * shows up only as a fleet that mysteriously stops updating, and a read route
 * accidentally moved to the socket just leaves the dashboard blank.
 */

interface HookState {
  status: string;
  lastEvent: string;
}

describe("/api/hooks trust boundary", { skip: !RUN_INTEGRATION }, () => {
  let server: BootedServer;

  before(async () => {
    server = await bootServer();
  });

  after(() => {
    server?.kill();
  });

  const SESSION = "hook-plane-probe";

  const ingest = (event: string): Promise<{ status: number; body: string }> =>
    socketRequest(server, `/api/hooks/${SESSION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: event, session_id: SESSION }),
    });

  it("binds the control socket owner-only", () => {
    const mode = statSync(controlSocketPath(server)).mode & 0o777;
    assert.equal(
      mode,
      0o600,
      "a group/other-readable control socket would let any local user forge hooks",
    );
  });

  it("accepts ingest over the socket without a token", async () => {
    // No credential on purpose: on the socket, being able to connect at all
    // IS the credential — the OS already restricted it to same-user on-box
    // processes, which is exactly the set of real agents.
    const res = await ingest("UserPromptSubmit");
    assert.equal(
      res.status,
      200,
      `ingest must succeed on the socket: ${res.body}`,
    );
  });

  it("refuses unauthenticated ingest on the public listener", async () => {
    // THE headline of this PR: the unauthenticated network write is gone.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/hooks/${SESSION}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "Stop" }),
      },
    );
    assert.notEqual(
      res.status,
      200,
      `unauthenticated hook ingest over TCP must NOT succeed — that is the ` +
        `forgery hole ADR-055 closes.\n${server.logs()}`,
    );
  });

  it("still serves the dashboard's read surface publicly, with a token", async () => {
    // Written over the socket above; read back over TCP here. Both planes are
    // the same process, so state is shared — the split is about reachability,
    // not about two disconnected stores.
    const { status, body } = await authedJson<HookState>(
      server,
      `/api/hooks/${SESSION}/status`,
    );
    assert.equal(status, 200);
    assert.equal(
      body.lastEvent,
      "UserPromptSubmit",
      "the public read surface must observe what socket ingest wrote",
    );
  });

  it("requires the token on the read surface", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/hooks`);
    assert.equal(
      res.status,
      401,
      "the notification/status poll must stay behind the token",
    );
  });

  it("does not serve the dashboard read routes on the socket", async () => {
    // The read surface is for the browser; putting it on the socket would be
    // harmless security-wise but would mean the dashboard had lost it.
    const res = await socketRequest(server, "/api/hooks");
    assert.equal(res.status, 404);
  });
});
