import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import {
  authedJson,
  type BootedServer,
  bootServer,
  boundedTeardown,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 (AUTONOMOS_INTEGRATION=1): the test harness can't be answered by ANOTHER
 * test's server. The usage-queue suite once failed a gate with
 * "POST /api/agents must create the agent: 401 !== 201", and passed alone.
 *
 * The mechanism, measured on macOS:
 *  - a server bound to `::` (every interface, the product default) and a
 *    socket bound to 127.0.0.1 can hold the SAME port at once;
 *  - a request to 127.0.0.1 then reaches the 127.0.0.1 socket, i.e. some
 *    other suite's server with a different token, which answers 401;
 *  - the OS can hand `::`:0 a port a 127.0.0.1 socket still holds.
 * The harness now binds 127.0.0.1 by default, and two sockets on the same
 * address can never share a port. This test makes the collision happen on
 * purpose: a stranger answering 401 holds 127.0.0.1:P, then the harness boots
 * on P. Acceptable outcomes: the boot is refused (address in use), or the
 * harness's own request reaches its own server. The bug is the third outcome:
 * the boot succeeds and the request gets the stranger's 401. (Linux refuses
 * the shared bind outright, so there this passes either way; macOS is where
 * the bug lived, and where this test turns RED without the fix.)
 */

describe("the test harness is never answered by another test's server", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  let stranger: Server | undefined;
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("test-server-bind", async () => {
      await Promise.all(booted.map((s) => s.kill()));
      for (const s of booted)
        rmSync(s.configDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      await new Promise<void>((r) =>
        stranger ? stranger.close(() => r()) : r(),
      );
    }),
  );

  it("a stranger on 127.0.0.1:P can't answer for a server the harness boots on P", async () => {
    stranger = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "a different server" }));
    });
    await new Promise<void>((r) => stranger?.listen(0, "127.0.0.1", r));
    const port = (stranger.address() as AddressInfo).port;

    let s: BootedServer;
    try {
      s = await bootServer({ extraArgs: [`--port=${port}`] });
    } catch (err) {
      // Refused: the address is taken. Nothing can be misrouted.
      assert.match(String(err), /exited|EADDRINUSE|address already in use/i);
      return;
    }
    booted.push(s);
    const r = await authedJson<unknown[]>(s, "/api/agents");
    assert.equal(
      r.status,
      200,
      `the harness's request reached a different server (${JSON.stringify(r.body)}):\n${s.logs()}`,
    );
  });

  it("a bindAll server is addressed at [::1], which a 127.0.0.1 stranger can't intercept", async () => {
    const s = await bootServer({ bindAll: true });
    booted.push(s);
    assert.match(s.baseUrl, /^http:\/\/\[::1\]:\d+$/);
    assert.equal((await authedJson<unknown[]>(s, "/api/agents")).status, 200);
  });
});
