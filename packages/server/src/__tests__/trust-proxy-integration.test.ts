import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1): `--trust-proxy=tailscale` on a
 * real server bound to loopback (ADR-137). tailscaled is simulated exactly as
 * measured on 1.102.3: it connects from 127.0.0.1 and sends X-Forwarded-For
 * (+ Tailscale-User-Login for user-owned nodes). CI has no tailscaled; the
 * live serve path was verified by hand (PR body).
 */

const WEAK = "QZXJ";

function req(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body
          ? { ...headers, "Content-Length": String(Buffer.byteLength(body)) }
          : headers,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

describe("trust-proxy=tailscale on a real server", {
  skip: !RUN_INTEGRATION,
  timeout: 180_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("trust-proxy", async () => {
      await Promise.all(booted.map((s) => s.kill()));
      for (const s of booted)
        rmSync(s.configDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
    }),
  );
  const boot = async (
    env: Record<string, string>,
    extraArgs: string[] = ["--host=127.0.0.1"],
  ) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const s = await bootServer({
        token: WEAK,
        extraArgs,
        prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")),
      });
      booted.push(s);
      return s;
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  };
  const logOf = (s: BootedServer) => {
    const p = join(s.configDir, "logs", "autonomos.log");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const viaServe = (ip: string, login?: string) => ({
    "X-Forwarded-For": ip,
    ...(login ? { "Tailscale-User-Login": login } : {}),
  });

  let s: BootedServer;

  it("a device behind tailscale serve is locked out like any other; this machine isn't", async () => {
    s = await boot({
      AUTONOMOS_TRUST_PROXY: "tailscale",
      AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT: "3",
    });
    const proxied = viaServe("100.64.1.2", "mallory@example.com");
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await req(s.port, "GET", "/api/agents", {
            ...proxied,
            Authorization: `Bearer wrong-${i}`,
          })
        ).status,
        401,
      );
    const right = await req(s.port, "GET", "/api/agents", {
      ...proxied,
      Authorization: `Bearer ${WEAK}`,
    });
    assert.equal(right.status, 423, "the proxied new device is locked out");
    // This machine itself (the CLI, a local dashboard): no X-Forwarded-For.
    assert.equal(
      (
        await req(s.port, "GET", "/api/agents", {
          Authorization: `Bearer ${WEAK}`,
        })
      ).status,
      200,
    );
  });

  it("the lockout says WHO tried (tailnet address + Tailscale login)", () => {
    assert.match(
      logOf(s),
      /the last from 100\.64\.1\.2, Tailscale user mallory@example\.com/,
    );
  });

  it("the mode shows on /api/auth/lock and in the boot log", async () => {
    const lock = JSON.parse(
      (
        await req(s.port, "GET", "/api/auth/lock", {
          Authorization: `Bearer ${WEAK}`,
        })
      ).body,
    );
    assert.equal(lock.trustProxy, "tailscale");
    assert.match(s.logs(), /Trusting tailscale serve/);
  });

  it("a malformed X-Forwarded-For from this machine is refused", async () => {
    const r = await req(s.port, "GET", "/api/agents", {
      "X-Forwarded-For": "100.64.1.2, 100.64.1.3",
      Authorization: `Bearer ${WEAK}`,
    });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).code, "BAD_PROXY_HEADER");
  });

  it("a signed-in device behind serve passes the CSRF guard with its ts.net origin", async () => {
    // (unlock first: the previous test left new devices locked)
    await req(
      s.port,
      "POST",
      "/api/auth/unlock",
      {
        Authorization: `Bearer ${WEAK}`,
        "Content-Type": "application/json",
      },
      "{}",
    );
    const tsHost = "box.example.ts.net";
    const browser = {
      ...viaServe("100.64.7.7", "terry@example.com"),
      Host: tsHost,
      Origin: `https://${tsHost}`,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    const login = await req(
      s.port,
      "POST",
      "/api/auth",
      browser,
      JSON.stringify({ token: WEAK }),
    );
    assert.equal(login.status, 200, login.body);
    const cookie = login.body; // body is {"ok":true}; the cookie came in Set-Cookie
    assert.ok(cookie.includes("ok"));
    const post = await req(
      s.port,
      "POST",
      "/api/templates",
      { ...browser, Authorization: `Bearer ${WEAK}` },
      JSON.stringify({
        name: "via-serve",
        role: "r",
        description: "d",
        systemPrompt: "s",
      }),
    );
    assert.ok(post.status < 300, `${post.status} ${post.body}`);
  });

  it("refuses to start in trust-proxy mode on a network bind (the LAN could go around serve)", async () => {
    for (const extraArgs of [[], ["--host=127.0.0.1,0.0.0.0"]]) {
      let refused: Error | undefined;
      try {
        const t = await boot({ AUTONOMOS_TRUST_PROXY: "tailscale" }, extraArgs);
        await t.kill();
      } catch (err) {
        refused = err as Error;
      }
      assert.ok(refused, `refused with ${JSON.stringify(extraArgs)}`);
      assert.match(refused.message, /exited \(code=2\)/);
      assert.match(
        refused.message,
        /needs autonomOS to listen on this machine only/,
      );
    }
  });

  it("mode OFF: the headers are never read (a forwarded request is this machine)", async () => {
    const t = await boot({ AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT: "3" });
    for (let i = 0; i < 3; i++)
      await req(t.port, "GET", "/api/agents", {
        ...viaServe("100.64.1.2"),
        Authorization: `Bearer wrong-${i}`,
      });
    assert.equal(
      (
        await req(t.port, "GET", "/api/agents", {
          ...viaServe("100.64.1.2"),
          Authorization: `Bearer ${WEAK}`,
        })
      ).status,
      200,
      "loopback (header ignored) is never locked",
    );
  });
});
