import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  HOOK_TIMEOUT,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — regression guard for
 * #442: after the per-port cookie rename (#428), a browser signed in through
 * the REAL login got 403 from every in-app update action, because the
 * operator-only check read a hard-coded cookie name the login no longer set.
 * The unit test pins the two names through a shared helper; this one pins
 * the PRODUCT: sign in exactly as the dashboard does, take whatever cookie
 * the server hands back, and every update/restore/check action must get
 * past authentication with it.
 *
 * "Past authentication" = anything but 401/403. These run unsupervised, so
 * the actions themselves are refused for other reasons (409 not supervised /
 * no rollback, 502 GitHub unreachable) — that's fine and expected; the
 * symptom was the 403 in front of them. A no-cookie control proves each
 * route really is protected, so "not 403" can't pass vacuously.
 */

/** The dashboard's update actions, as its buttons send them. */
const ACTIONS: {
  name: string;
  method: string;
  path: string;
  body?: unknown;
}[] = [
  {
    name: "Check for updates",
    method: "POST",
    path: "/api/system/check-updates",
  },
  { name: "update status", method: "GET", path: "/api/system/upgrade" },
  {
    name: "Update",
    method: "POST",
    path: "/api/system/upgrade",
    body: { when: "now" },
  },
  { name: "Cancel update", method: "DELETE", path: "/api/system/upgrade" },
  { name: "list snapshots", method: "GET", path: "/api/system/snapshots" },
  { name: "Restore", method: "POST", path: "/api/system/rollback", body: {} },
];

describe("update actions with a REAL login cookie (#442 regression guard)", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  let server: BootedServer;
  let base: string;
  let cookie = "";

  before(async () => {
    server = await bootServer();
    base = `http://127.0.0.1:${server.port}`;
    // Sign in the way the dashboard does (POST /api/auth, ADR-117), and keep
    // exactly the cookie the server sets — no name computed by the test.
    const login = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: server.token }),
    });
    assert.equal(login.status, 200, "login succeeds");
    const setCookie = login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    assert.match(cookie, /^[^=]+=.+/, `login set a cookie (got: ${setCookie})`);
  }, HOOK_TIMEOUT);

  after(() =>
    boundedTeardown("update-login", async () => {
      await server?.kill();
      if (server) rmSync(server.configDir, { recursive: true, force: true });
    }),
  );

  /** A same-origin browser request: what the dashboard's fetch sends. */
  const send = (a: (typeof ACTIONS)[number], withCookie: boolean) =>
    fetch(`${base}${a.path}`, {
      method: a.method,
      headers: {
        ...(withCookie && { Cookie: cookie }),
        "Sec-Fetch-Site": "same-origin",
        Origin: base,
        ...(a.body !== undefined && { "Content-Type": "application/json" }),
      },
      body: a.body === undefined ? undefined : JSON.stringify(a.body),
    });

  for (const a of ACTIONS) {
    it(`${a.name} (${a.method} ${a.path}) gets past auth with the login cookie`, async () => {
      // Control: without the cookie the route must refuse — else "not 403"
      // below would pass for a route that simply stopped checking.
      const bare = await send(a, false);
      assert.ok(
        bare.status === 401 || bare.status === 403,
        `${a.name} without a cookie should be refused, got ${bare.status}`,
      );
      const res = await send(a, true);
      const body = await res.text();
      assert.ok(
        res.status !== 401 && res.status !== 403,
        `${a.name} with the real login cookie got ${res.status}: ${body.slice(0, 200)}`,
      );
    });
  }
});
