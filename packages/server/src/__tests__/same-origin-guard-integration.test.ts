import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  HOOK_TIMEOUT,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1): the CSRF / cross-site WebSocket
 * guard (V1) is MOUNTED in front of the real server's routes. The unit suite
 * pins the decision table. This one pins placement: a route that skips the
 * guard is the bug. That can happen if it's registered above it (Hono runs
 * handlers in registration order) or mounted under a prefix it doesn't cover.
 *
 * The session cookie comes from a REAL login, whatever Set-Cookie
 * `POST /api/auth` returns. #392's guard hand-crafted the legacy name, and it
 * broke silently when ADR-117 made the cookie per-port.
 *
 * Requests go through node:http so the test controls Origin, Host and
 * Sec-Fetch-Site exactly as a browser would send them.
 */

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers:
          body === undefined
            ? headers
            : { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Resolves "open" or the refusal status; never hangs. */
function wsAttempt(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const t = setTimeout(() => {
      ws.terminate();
      resolve("timeout");
    }, 5000);
    ws.on("open", () => {
      clearTimeout(t);
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(t);
      resolve(String(res.statusCode));
      ws.terminate();
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve("error");
    });
  });
}

describe("sameOriginGuard is mounted on the real server", {
  skip: !RUN_INTEGRATION,
  timeout: 60_000,
}, () => {
  let server: BootedServer;
  let self: string; // 127.0.0.1:<port>
  let cookie: string; // name=value from the real login
  const evil = () => `http://127.0.0.1:${server.port + 1}`;

  before(async () => {
    server = await bootServer();
    self = `127.0.0.1:${server.port}`;
    const login = await raw(
      server.port,
      "POST",
      "/api/auth",
      {
        Host: self,
        Origin: `http://${self}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      JSON.stringify({ token: server.token }),
    );
    assert.equal(login.status, 200, login.body);
    const set = login.headers["set-cookie"];
    const first = (Array.isArray(set) ? set[0] : set) ?? "";
    cookie = first.split(";")[0];
    assert.match(cookie, /^autonomos_token\w*=/, "login set a session cookie");
  }, HOOK_TIMEOUT);

  after(() =>
    boundedTeardown("same-origin-guard", async () => {
      await server?.kill();
      if (server) rmSync(server.configDir, { recursive: true, force: true });
    }),
  );

  /** What a hostile page on another port of this host makes the browser send. */
  const sameSite = () => ({
    Host: self,
    Cookie: cookie,
    Origin: evil(),
    "Sec-Fetch-Site": "same-site",
  });

  it("the audit PoC: a same-site page cannot create a template", async () => {
    const res = await raw(
      server.port,
      "POST",
      "/api/templates",
      { ...sameSite(), "Content-Type": "application/json" },
      JSON.stringify({
        name: "pwned",
        role: "x",
        description: "x",
        systemPrompt: "x",
      }),
    );
    assert.equal(res.status, 403, res.body);
    assert.equal(JSON.parse(res.body).code, "CROSS_ORIGIN");
    const list = await raw(server.port, "GET", "/api/templates", {
      Host: self,
      Cookie: cookie,
    });
    assert.ok(!list.body.includes("pwned"), "nothing was created");
  });

  it("refuses every mutating route family from a same-site page", async () => {
    const routes: [string, string][] = [
      ["POST", "/api/agents"],
      ["POST", "/api/agents/restart-all"],
      ["POST", "/api/agents/x/kill"],
      ["DELETE", "/api/agents/x"],
      ["PUT", "/api/settings"],
      ["POST", "/api/env-presets"],
      ["POST", "/api/schedules/x/run"],
      ["PUT", "/api/scheduler/settings"],
      ["POST", "/api/system/upgrade"],
      ["POST", "/api/system/check-updates"],
      ["POST", "/api/hooks/x/read"],
      ["POST", "/api/auth"],
    ];
    for (const [method, path] of routes) {
      const res = await raw(
        server.port,
        method,
        path,
        { ...sameSite(), "Content-Type": "application/json" },
        "{}",
      );
      assert.equal(
        res.status,
        403,
        `${method} ${path} → ${res.status} ${res.body}`,
      );
    }
  });

  it("refuses an older browser's cross-port POST (Origin only, no Fetch Metadata)", async () => {
    const { "Sec-Fetch-Site": _, ...old } = sameSite();
    const res = await raw(
      server.port,
      "POST",
      "/api/templates",
      { ...old, "Content-Type": "application/json" },
      "{}",
    );
    assert.equal(res.status, 403);
  });

  it("refuses a text/plain form post (no preflight) carrying the cookie", async () => {
    const res = await raw(
      server.port,
      "POST",
      "/api/templates",
      { Host: self, Cookie: cookie, "Content-Type": "text/plain" },
      JSON.stringify({
        name: "pwned2",
        role: "x",
        description: "x",
        systemPrompt: "x",
      }),
    );
    assert.equal(res.status, 403, res.body);
  });

  it("refuses cross-port WebSocket upgrades on /ws/agents and /ws/terminal", async () => {
    for (const path of ["/ws/agents", "/ws/terminal/none"]) {
      const got = await wsAttempt(`ws://${self}${path}`, {
        Cookie: cookie,
        Origin: evil(),
      });
      assert.equal(got, "403", path);
    }
  });

  it("the dashboard itself still works: same-origin POST and WS", async () => {
    const res = await raw(
      server.port,
      "POST",
      "/api/templates",
      {
        Host: self,
        Cookie: cookie,
        Origin: `http://${self}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      JSON.stringify({
        name: "csrf-ok",
        role: "r",
        description: "d",
        systemPrompt: "s",
      }),
    );
    assert.ok(res.status < 300, `${res.status} ${res.body}`);
    assert.equal(
      await wsAttempt(`ws://${self}/ws/agents`, {
        Cookie: cookie,
        Origin: `http://${self}`,
      }),
      "open",
    );
  });

  it("header-token clients still work: Node fetch, curl-style, ws", async () => {
    const auth = `Bearer ${server.token}`;
    // Node fetch with a string body and no type sends text/plain.
    const f = await fetch(`http://${self}/api/templates`, {
      method: "POST",
      headers: { Authorization: auth },
      body: JSON.stringify({
        name: "csrf-bearer",
        role: "r",
        description: "d",
        systemPrompt: "s",
      }),
    });
    assert.ok(f.status < 300, `node fetch → ${f.status}`);
    // curl -d defaults to urlencoded.
    const c = await raw(server.port, "DELETE", "/api/templates/csrf-bearer", {
      Host: self,
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    assert.ok(c.status < 300, `curl-style → ${c.status} ${c.body}`);
    assert.equal(
      await wsAttempt(`ws://${self}/ws/agents`, { Authorization: auth }),
      "open",
    );
  });
});
