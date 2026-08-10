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
 *
 * ADR-055 PR B additionally gates ingest on a per-agent token: reaching the
 * socket is necessary but not sufficient, so one same-user process can't forge
 * hooks for another agent. These tests assert the rejection contract; the happy
 * path (a real agent's own curl carrying its token) is covered end-to-end by
 * agent-spawn-prompt.test.ts.
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

  it("rejects socket ingest that lacks a valid per-agent token", async () => {
    // ADR-055 PR B tightened PR A's model: reaching the socket is necessary but
    // no longer sufficient. SESSION was never spawned, so it has no minted
    // token — a same-user process that can open the socket still cannot forge a
    // hook for an agent it isn't. (A real agent's own curl carries the token;
    // that happy path is covered end-to-end by agent-spawn-prompt.test.ts.)
    const res = await ingest("UserPromptSubmit");
    assert.equal(
      res.status,
      401,
      `tokenless socket ingest must be refused post-PR-B: ${res.body}`,
    );
  });

  it("refuses unauthenticated ingest on the public listener", async () => {
    // Still true, and now doubly so: no route on TCP + no valid token.
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
      `unauthenticated hook ingest over TCP must NOT succeed.\n${server.logs()}`,
    );
  });

  it("the rejected write did not mutate agent state", async () => {
    // The tokenless ingest above must have changed nothing — read it back on
    // the public surface and confirm the session never reached a live status.
    // Bulk endpoint — the per-session single was removed in the dead-surface
    // pass. A session the ingest never touched has NO entry here, which is
    // itself the assertion: nothing was written.
    const { body } = await authedJson<Record<string, { status: HookState }>>(
      server,
      "/api/hooks",
    );
    assert.notEqual(
      body[SESSION]?.status.lastEvent,
      "UserPromptSubmit",
      "a rejected hook must not have written status",
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
