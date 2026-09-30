import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { FREE_FAILURES } from "../authRateLimit.js";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  HOOK_TIMEOUT,
  RUN_INTEGRATION,
  sleep,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1): failed auth is throttled on the
 * REAL public listener (V2). The audit's PoC made 20,000 wrong guesses in
 * 0.8s, all plain 401s. Here the guesser is refused after FREE_FAILURES, and
 * refused BEFORE its credential is evaluated, while the operator (a repeated
 * stale cookie, then the right token) is never locked out for long.
 *
 * Each case uses its own server: the limiter is per process, and every request
 * here comes from 127.0.0.1.
 */

function bearer(base: string, token: string, path = "/api/agents") {
  return fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function wsStatus(url: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_q, res) => {
      resolve(String(res.statusCode));
      ws.terminate();
    });
    ws.on("error", () => resolve("error"));
  });
}

describe("failed-auth throttle on the real server", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  const servers: BootedServer[] = [];
  const boot = async () => {
    const s = await bootServer();
    servers.push(s);
    return { s, base: `http://127.0.0.1:${s.port}` };
  };
  after(() =>
    boundedTeardown("auth-rate-limit", async () => {
      for (const s of servers) {
        await s.kill();
        rmSync(s.configDir, { recursive: true, force: true });
      }
    }),
  );

  let a: { s: BootedServer; base: string };
  before(async () => {
    a = await boot();
  }, HOOK_TIMEOUT);

  it("the audit PoC: a guesser is refused after the free allowance, before evaluation", async () => {
    for (let i = 0; i < FREE_FAILURES; i++)
      assert.equal(
        (await bearer(a.base, `guess-${i}`)).status,
        401,
        `guess ${i}`,
      );
    assert.equal(
      (await bearer(a.base, "guess-last")).status,
      401,
      "the one that locks",
    );

    const burst = await Promise.all(
      Array.from({ length: 200 }, (_, i) => bearer(a.base, `burst-${i}`)),
    );
    const codes = new Set(burst.map((r) => r.status));
    assert.deepEqual([...codes], [429], "every burst guess refused");
    const r = burst[0];
    assert.ok(Number(r.headers.get("retry-after")) >= 1, "Retry-After");
    const body = await r.json();
    assert.equal(body.code, "RATE_LIMITED");
    assert.ok(!JSON.stringify(body).includes("burst-0"), "no echo");

    // Refused BEFORE evaluation: even the right token waits out the lock…
    assert.equal((await bearer(a.base, a.s.token)).status, 429);
    // …and the lock is short at this point (1s, doubling from there).
    await sleep(1100);
    assert.equal((await bearer(a.base, a.s.token)).status, 200, "then gets in");
    // A success clears the address: a fresh allowance.
    assert.equal((await bearer(a.base, "after-success")).status, 401);
  });

  it("POST /api/auth and WebSocket upgrades are throttled too", async () => {
    const b = await boot();
    for (let i = 0; i <= FREE_FAILURES; i++) {
      const res = await fetch(`${b.base}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: `login-guess-${i}` }),
      });
      assert.equal(res.status, 401);
    }
    const login = await fetch(`${b.base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "login-guess-x" }),
    });
    assert.equal(login.status, 429, "login throttled");
    assert.equal(
      await wsStatus(`ws://127.0.0.1:${b.s.port}/ws/agents`, "ws-guess"),
      "429",
      "WS upgrade throttled (shared per-address state)",
    );
  });

  it("a stale token repeated forever never locks the operator out", async () => {
    const c = await boot();
    for (let i = 0; i < 60; i++)
      assert.equal(
        (await bearer(c.base, "stale-token-of-another-instance")).status,
        401,
      );
    const ok = await fetch(`${c.base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: c.s.token }),
    });
    assert.equal(ok.status, 200, "the real token signs in immediately");
  });

  it("a request with no credential at all is not a guess", async () => {
    const d = await boot();
    for (let i = 0; i < 60; i++)
      assert.equal((await fetch(`${d.base}/api/agents`)).status, 401);
    assert.equal((await bearer(d.base, d.s.token)).status, 200);
  });
});
