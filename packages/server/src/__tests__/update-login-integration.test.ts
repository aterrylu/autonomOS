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
 * Each action must reach its EXACT post-auth answer — proving it got past
 * auth AND where it stopped. A no-cookie control proves each route really
 * is protected, so the green can't be vacuous.
 *
 * SAFE BY CONSTRUCTION (nox, #483): this POSTs "Update now" and "Restore",
 * so the server must never be able to act on them, wherever the suite runs —
 * including inside an agent under the live service:
 *   - the release API points at a dead loopback port, so the server never
 *     learns of a newer release: Update stops at NO_UPDATE, BEFORE the
 *     supervisor check that could launch a job (and the suite is offline);
 *   - INVOCATION_ID / XPC_SERVICE_NAME are removed, so the test server can
 *     never take itself for the supervised daemon.
 */

/** The dashboard's update actions, as its buttons send them, and the exact
 *  post-auth answer each must reach in this sandbox. */
const ACTIONS: {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  status: number;
  /** The error envelope's `code`; any of these. */
  codes?: string[];
}[] = [
  {
    name: "Check for updates",
    method: "POST",
    path: "/api/system/check-updates",
    // The release API is dead: proves the server can't reach one at all.
    status: 502,
    codes: ["CHECK_FAILED"],
  },
  {
    name: "update status",
    method: "GET",
    path: "/api/system/upgrade",
    status: 200,
  },
  {
    name: "Update",
    method: "POST",
    path: "/api/system/upgrade",
    body: { when: "now" },
    // Stops before the supervisor check: nothing can launch.
    status: 409,
    codes: ["NO_UPDATE"],
  },
  {
    name: "Cancel update",
    method: "DELETE",
    path: "/api/system/upgrade",
    status: 200,
  },
  {
    name: "list snapshots",
    method: "GET",
    path: "/api/system/snapshots",
    status: 200,
  },
  {
    name: "Restore",
    method: "POST",
    path: "/api/system/rollback",
    body: {},
    status: 409,
    codes: ["NO_ROLLBACK", "NOT_SUPERVISED"],
  },
];

describe("update actions with a REAL login cookie (#442 regression guard)", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  let server: BootedServer;
  let base: string;
  let cookie = "";

  before(async () => {
    server = await bootServer({
      env: {
        AUTONOMOS_RELEASE_API_URL: "http://127.0.0.1:1",
        INVOCATION_ID: undefined,
        XPC_SERVICE_NAME: undefined,
      },
    });
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

    // GATE, before ANY test sends Update/Restore: prove the server can't
    // reach a release API. If the sandbox override were ever lost, this
    // throws and the whole suite stops here — node:test would otherwise run
    // the Update test right after a failed precondition test.
    const probe = await fetch(`${base}/api/system/check-updates`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
        Origin: base,
      },
    });
    const probeBody = await probe.text();
    assert.equal(
      probe.status,
      502,
      `the server reached a release API (${probe.status}: ${probeBody.slice(0, 200)}) — refusing to send Update/Restore from this suite`,
    );
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
      assert.equal(
        res.status,
        a.status,
        `${a.name} with the real login cookie got ${res.status}: ${body.slice(0, 200)}`,
      );
      if (a.codes) {
        const code = (JSON.parse(body) as { code?: string }).code ?? "";
        assert.ok(a.codes.includes(code), `${a.name}: code ${code}`);
      }
    });
  }
});
