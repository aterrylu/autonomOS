import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1): `--host=127.0.0.1,<address>`
 * (ADR-136) on a real server. The second listener serves the SAME app, so the
 * CSRF guard and the new-device lock apply there unchanged; an address that
 * isn't up never blocks the start, and loopback is served at once.
 *
 * The LAN address stands in for the tailnet IP (both are just "a second
 * interface"). 192.0.2.1 (TEST-NET-1, never assigned) stands in for a tailnet
 * IP before Tailscale is up.
 */

const WEAK = "QZXJ";
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

function raw(
  host: string,
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port,
        method,
        path,
        headers: body
          ? { ...headers, "Content-Length": String(Buffer.byteLength(body)) }
          : headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("--host list on a real server", {
  skip:
    !RUN_INTEGRATION || !lanIp ? "needs integration + a LAN address" : false,
  timeout: 180_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("bind-hosts", async () => {
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
  const boot = async (opts: Parameters<typeof bootServer>[0]) => {
    const saved = process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT;
    process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT = "3";
    try {
      const s = await bootServer(opts);
      booted.push(s);
      return s;
    } finally {
      if (saved === undefined)
        delete process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT;
      else process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT = saved;
    }
  };
  const get = (host: string, s: BootedServer, token: string) =>
    raw(host, s.port, "GET", "/api/agents", {
      Host: `${host}:${s.port}`,
      Authorization: `Bearer ${token}`,
    });

  let s: BootedServer;

  it("serves loopback AND the second address", async () => {
    s = await boot({
      token: WEAK,
      extraArgs: [`--host=127.0.0.1,${lanIp}`],
      prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")),
    });
    assert.equal(await get("127.0.0.1", s, WEAK), 200);
    // The extra listener may take a beat after "listening" on loopback.
    let lan = 0;
    for (let i = 0; i < 20 && lan !== 200; i++) {
      lan = await get(lanIp as string, s, WEAK).catch(() => 0);
      if (lan !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(lan, 200);
    assert.match(s.logs(), new RegExp(`also listening on http://${lanIp}`));
  });

  it("the CSRF guard applies on the second listener", async () => {
    const code = await raw(
      lanIp as string,
      s.port,
      "POST",
      "/api/templates",
      {
        Host: `${lanIp}:${s.port}`,
        Origin: `http://${lanIp}:${s.port + 1}`,
        "Sec-Fetch-Site": "same-site",
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEAK}`,
      },
      "{}",
    );
    assert.equal(code, 403);
  });

  it("the new-device lock applies on the second listener; loopback stays open", async () => {
    // A fresh server, so the LAN address hasn't signed in (isn't known) yet.
    const t = await boot({
      token: WEAK,
      extraArgs: [`--host=127.0.0.1,${lanIp}`],
      prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")),
    });
    for (let i = 0; i < 20; i++) {
      const c = await get(lanIp as string, t, `wrong-${i}`).catch(() => 0);
      if (c === 423) break;
      if (c === 0) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(await get(lanIp as string, t, WEAK), 423, "locked on LAN");
    assert.equal(await get("127.0.0.1", t, WEAK), 200, "loopback open");
  });

  it("an address that isn't up never blocks the start, and logs once while waiting", async () => {
    const u = await boot({
      token: WEAK,
      extraArgs: ["--host=127.0.0.1,192.0.2.1"],
      prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")),
    });
    assert.equal(await get("127.0.0.1", u, WEAK), 200, "served at once");
    await new Promise((r) => setTimeout(r, 11_000)); // two retries
    const waiting = u
      .logs()
      .split("\n")
      .filter((l) => l.includes("192.0.2.1 isn't available yet"));
    assert.equal(waiting.length, 1, "one line, not one per retry");
  });
});
