import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  HOOK_TIMEOUT,
  RUN_INTEGRATION,
  waitFor,
} from "./helpers/test-server.js";

/**
 * L3 integration (CI-only, AUTONOMOS_INTEGRATION=1) — the server half of the
 * sign-in link (`…/#token=<token>`, ADR-117).
 *
 * The browser half (strip the fragment, POST it) lives in index.html and is
 * proven in a real browser; this suite pins what the SERVER promises it:
 *
 *   - the session cookie is named per port, so two instances on one host (the
 *     live one and a QA one) no longer overwrite each other's login, and the
 *     legacy shared name is still READ so an upgrade logs nobody out;
 *   - a refused exchange (a stale link) never clears a working session;
 *   - `?token=` on the public listener still works this release, warns ONCE,
 *     and never writes the token into the log;
 *   - `--print-url` prints the sign-in link to the terminal and NOT the log.
 */

const LEGACY = "autonomos_token";

function logFile(server: BootedServer): string {
  const p = join(server.configDir, "logs", "autonomos.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("sign-in link: server contract", {
  skip: !RUN_INTEGRATION,
  timeout: 60_000,
}, () => {
  let server: BootedServer;
  let base: string;

  before(async () => {
    server = await bootServer({ extraArgs: ["--print-url"] });
    base = `http://127.0.0.1:${server.port}`;
  }, HOOK_TIMEOUT);

  after(() =>
    boundedTeardown("magic-link-auth", async () => {
      await server?.kill();
      if (server) rmSync(server.configDir, { recursive: true, force: true });
    }),
  );

  const agents = (headers: Record<string, string> = {}, query = "") =>
    fetch(`${base}/api/agents${query}`, { headers });

  it("POST /api/auth sets a PER-PORT httpOnly cookie", async () => {
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: server.token }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${LEGACY}_${server.port}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const withIt = await agents({
      Cookie: `${LEGACY}_${server.port}=${server.token}`,
    });
    assert.equal(withIt.status, 200, "the per-port cookie authenticates");
  });

  it("still reads the LEGACY cookie name, so an upgrade logs nobody out", async () => {
    const res = await agents({ Cookie: `${LEGACY}=${server.token}` });
    assert.equal(res.status, 200);
  });

  it("a legacy-cookie session is MOVED onto the per-port cookie", async () => {
    const res = await agents({ Cookie: `${LEGACY}=${server.token}` });
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${LEGACY}_${server.port}=`));
    assert.match(setCookie, /HttpOnly/i);
    // …and a per-port session is not re-set on every request.
    const again = await agents({
      Cookie: `${LEGACY}_${server.port}=${server.token}`,
    });
    assert.equal(again.headers.get("set-cookie"), null);
  });

  it("a STALE cookie never shadows a valid credential", async () => {
    // Another instance's token in the shared legacy cookie…
    const stale = `${LEGACY}=token-of-another-instance`;
    assert.equal(
      (
        await agents({
          Cookie: `${stale}; ${LEGACY}_${server.port}=${server.token}`,
        })
      ).status,
      200,
      "valid per-port cookie wins over a stale legacy one",
    );
    assert.equal(
      (await agents({ Cookie: stale, Authorization: `Bearer ${server.token}` }))
        .status,
      200,
      "valid Bearer wins over a stale cookie",
    );
    assert.equal((await agents({ Cookie: stale })).status, 401);
  });

  it("a same-LENGTH multibyte cookie is a mismatch, not a 500", async () => {
    // Planted by any page on another localhost port (cookies ignore port).
    // Same JS string length as the token, different BYTE length: a naive
    // timingSafeEqual throws, and it is tried before the Bearer header.
    const junk = "é".repeat(server.token.length);
    const res = await agents({
      Cookie: `${LEGACY}=${encodeURIComponent(junk)}`,
      Authorization: `Bearer ${server.token}`,
    });
    assert.equal(res.status, 200, "the valid Bearer still wins");
    const login = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: junk }),
    });
    assert.equal(
      login.status,
      401,
      "a multibyte login attempt is refused, not a 500",
    );
  });

  it("another port's cookie does not authenticate this one", async () => {
    const res = await agents({
      Cookie: `${LEGACY}_${server.port + 1}=${server.token}`,
    });
    assert.equal(res.status, 401);
  });

  it("a refused exchange (stale link) never clears the existing session", async () => {
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${LEGACY}_${server.port}=${server.token}`,
      },
      body: JSON.stringify({ token: "a-stale-token-from-another-instance" }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null, "no cookie rewrite");
    const still = await agents({
      Cookie: `${LEGACY}_${server.port}=${server.token}`,
    });
    assert.equal(still.status, 200);
  });

  it("public ?token= still works, warns ONCE, and never logs the token", async () => {
    const q = `?token=${encodeURIComponent(server.token)}`;
    assert.equal((await agents({}, q)).status, 200);
    assert.equal((await agents({}, q)).status, 200);
    assert.equal((await agents({}, "?token=wrong")).status, 401);

    const warning = "authenticated with ?token= on the public listener";
    assert.ok(
      await waitFor(async () => logFile(server).includes(warning), {
        timeoutMs: 5000,
      }),
      `deprecation warning in the log\n${server.logs()}`,
    );
    const log = logFile(server);
    assert.equal(log.split(warning).length - 1, 1, "warned exactly once");
    assert.ok(!log.includes(server.token), "the token never reaches the log");
  });

  it("Bearer never triggers the deprecation path", async () => {
    const res = await agents({ Authorization: `Bearer ${server.token}` });
    assert.equal(res.status, 200);
  });

  it("--print-url prints the sign-in link to the terminal, never the log", async () => {
    const link = `Sign in: http://localhost:${server.port}/#token=${encodeURIComponent(server.token)}`;
    assert.ok(
      await waitFor(async () => server.logs().includes(link), {
        timeoutMs: 5000,
      }),
      "sign-in link on stdout",
    );
    assert.ok(!server.logs().includes("?token="), "never a query link");
    assert.ok(
      !logFile(server).includes(server.token),
      "the rotating log never holds the token",
    );
  });
});
