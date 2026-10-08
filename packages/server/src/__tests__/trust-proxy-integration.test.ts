import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
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
 * real server (ADR-140), with identity headers trusted ONLY on the owner-only
 * serve socket (ADR-153). tailscaled is simulated exactly as measured on
 * 1.102.3: it connects to the socket and sends X-Forwarded-For (+
 * Tailscale-User-Login for user-owned nodes). CI has no tailscaled; the live
 * `tailscale serve --bg unix:<path>` path was verified by hand (PR body).
 *
 * Every boot passes --serve-socket inside its own temp dir: the macOS default
 * would be the REAL Tailscale app-group folder, which a test must never touch.
 */

const WEAK = "QZXJ";

type Target = { port: number } | { socketPath: string };

function req(
  to: Target,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        ...("port" in to ? { host: "127.0.0.1", port: to.port } : to),
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

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`no serve socket at ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("trust-proxy=tailscale on a real server, over the serve socket", {
  skip: !RUN_INTEGRATION,
  timeout: 180_000,
}, () => {
  const booted: BootedServer[] = [];
  const dirs: string[] = [];
  after(() =>
    boundedTeardown("trust-proxy", async () => {
      await Promise.all(booted.map((s) => s.kill()));
      for (const d of [...booted.map((s) => s.configDir), ...dirs])
        rmSync(d, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
    }),
  );
  /** A short temp socket path (unix socket paths cap at ~104 bytes). */
  const socketPathFor = () => {
    const d = mkdtempSync(join(tmpdir(), "tps-"));
    dirs.push(d);
    return join(d, "serve.sock");
  };
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
        // No --host means the product default (every interface), which the
        // refusal tests depend on; the harness alone would bind loopback.
        bindAll: !extraArgs.some((a) => a.startsWith("--host")),
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
  let sock: string;

  it("a device behind tailscale serve is locked out like any other; this machine isn't", async () => {
    sock = socketPathFor();
    s = await boot(
      {
        AUTONOMOS_TRUST_PROXY: "tailscale",
        AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT: "3",
      },
      ["--host=127.0.0.1", `--serve-socket=${sock}`],
    );
    await waitForSocket(sock);
    const proxied = viaServe("100.64.1.2", "mallory@example.com");
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await req({ socketPath: sock }, "GET", "/api/agents", {
            ...proxied,
            Authorization: `Bearer wrong-${i}`,
          })
        ).status,
        401,
      );
    const right = await req({ socketPath: sock }, "GET", "/api/agents", {
      ...proxied,
      Authorization: `Bearer ${WEAK}`,
    });
    assert.equal(right.status, 423, "the proxied new device is locked out");
    // This machine itself, browsing plainly over loopback TCP: unaffected.
    assert.equal(
      (
        await req({ port: s.port }, "GET", "/api/agents", {
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

  it("the socket is owner-only, and the mode + exact serve command show on /api/auth/lock and in the log", async () => {
    assert.equal(statSync(sock).mode & 0o777, 0o600);
    const lock = JSON.parse(
      (
        await req({ port: s.port }, "GET", "/api/auth/lock", {
          Authorization: `Bearer ${WEAK}`,
        })
      ).body,
    );
    assert.equal(lock.trustProxy, "tailscale");
    assert.equal(lock.serveCommand, `tailscale serve --bg unix:${sock}`);
    assert.ok(
      s
        .logs()
        .includes(`Point it there once: tailscale serve --bg unix:${sock}`),
    );
  });

  it("FAILS CLOSED: serve pointed at the TCP port (identity headers on loopback TCP) gets a 400 naming the socket command", async () => {
    const r = await req({ port: s.port }, "GET", "/api/agents", {
      ...viaServe("100.64.7.7", "terry@example.com"),
      Authorization: `Bearer ${WEAK}`,
    });
    assert.equal(r.status, 400);
    const body = JSON.parse(r.body);
    assert.equal(body.code, "SERVE_NOT_ON_SOCKET");
    assert.ok(
      body.error.includes(`tailscale serve --bg unix:${sock}`),
      body.error,
    );
  });

  it("a malformed X-Forwarded-For on the socket is refused", async () => {
    const r = await req({ socketPath: sock }, "GET", "/api/agents", {
      "X-Forwarded-For": "100.64.1.2, 100.64.1.3",
      Authorization: `Bearer ${WEAK}`,
    });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).code, "BAD_PROXY_HEADER");
  });

  it("a signed-in device behind serve passes the CSRF guard with its ts.net origin", async () => {
    // (unlock first: an earlier test left new devices locked)
    await req(
      { port: s.port },
      "POST",
      "/api/auth/unlock",
      { Authorization: `Bearer ${WEAK}`, "Content-Type": "application/json" },
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
      { socketPath: sock },
      "POST",
      "/api/auth",
      browser,
      JSON.stringify({ token: WEAK }),
    );
    assert.equal(login.status, 200, login.body);
    const post = await req(
      { socketPath: sock },
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
    for (const extraArgs of [
      [`--serve-socket=${socketPathFor()}`],
      ["--host=127.0.0.1,0.0.0.0", `--serve-socket=${socketPathFor()}`],
    ]) {
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

  it("a NEW install behind serve refuses a weak token, like any network bind", async () => {
    let refused: Error | undefined;
    try {
      const saved = process.env.AUTONOMOS_TRUST_PROXY;
      process.env.AUTONOMOS_TRUST_PROXY = "tailscale";
      try {
        // no prepareConfigDir: an empty config dir is a fresh install
        const t = await bootServer({
          token: WEAK,
          extraArgs: ["--host=127.0.0.1", `--serve-socket=${socketPathFor()}`],
        });
        booted.push(t);
      } finally {
        if (saved === undefined) delete process.env.AUTONOMOS_TRUST_PROXY;
        else process.env.AUTONOMOS_TRUST_PROXY = saved;
      }
    } catch (err) {
      refused = err as Error;
    }
    assert.ok(
      refused,
      "a fresh install with a weak token behind serve must not start",
    );
    assert.match(refused.message, /exited \(code=2\)/);
  });

  it("mode OFF: no serve socket, and forwarded headers on loopback are never read", async () => {
    const off = socketPathFor();
    const t = await boot({ AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT: "3" }, [
      "--host=127.0.0.1",
      `--serve-socket=${off}`,
    ]);
    for (let i = 0; i < 3; i++)
      await req({ port: t.port }, "GET", "/api/agents", {
        ...viaServe("100.64.1.2"),
        Authorization: `Bearer wrong-${i}`,
      });
    assert.equal(
      (
        await req({ port: t.port }, "GET", "/api/agents", {
          ...viaServe("100.64.1.2"),
          Authorization: `Bearer ${WEAK}`,
        })
      ).status,
      200,
      "loopback (headers ignored) is never locked",
    );
    assert.equal(existsSync(off), false, "no socket without trust-proxy");
    // A warning: it lands in the rotating log, not stdout.
    assert.match(
      logOf(t) + t.logs(),
      /--serve-socket is set but --trust-proxy=tailscale isn't/,
    );
  });
});
