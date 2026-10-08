import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1): the new-device lock (ADR-148) on a
 * real server with a short token. Loopback is exempt by design, so the
 * "attacker" reaches the server through this machine's LAN address, a real
 * non-loopback peer. Skipped when the machine has none.
 *
 * The cap is lowered to 5 (AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT) so the test
 * doesn't wait out the per-address backoff that starts after 10 failures.
 */

const WEAK = "QZXJ";
const LIMIT = "5";
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const CLI_ENTRY = fileURLToPath(
  new URL("../../../cli/src/index.ts", import.meta.url),
);
const TSX = fileURLToPath(
  new URL("../../node_modules/.bin/tsx", import.meta.url),
);

describe("new-device lock on a real server", {
  skip:
    !RUN_INTEGRATION || !lanIp ? "needs integration + a LAN address" : false,
  timeout: 180_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("new-device-lock", async () => {
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
    process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT = LIMIT;
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
  const fromLan = (s: BootedServer, token: string) =>
    fetch(`http://${lanIp}:${s.port}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const fromLoopback = (s: BootedServer, token: string) =>
    fetch(`http://127.0.0.1:${s.port}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  let s: BootedServer;

  it("after LIMIT wrong tokens from a new device, even the RIGHT token from a new device is refused", async () => {
    s = await boot({
      token: WEAK,
      prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")), // an existing install
    });
    // A stale token repeated is not a guess: it never moves the count.
    for (let i = 0; i < 3 * Number(LIMIT); i++)
      assert.equal((await fromLan(s, "stale-token")).status, 401);
    // stale-token counted once; LIMIT-1 more distinct values reach the cap.
    for (let i = 0; i < Number(LIMIT) - 1; i++)
      assert.equal((await fromLan(s, `guess-${i}`)).status, 401, `guess ${i}`);
    const right = await fromLan(s, WEAK);
    assert.equal(right.status, 423, "refused unevaluated");
    assert.equal((await right.json()).code, "NEW_DEVICES_LOCKED");
    assert.equal((await fromLan(s, "another")).status, 423);
  });

  it("this machine (loopback) keeps working, and sees the lock", async () => {
    assert.equal((await fromLoopback(s, WEAK)).status, 200);
    const lock = await (
      await fetch(`http://127.0.0.1:${s.port}/api/auth/lock`, {
        headers: { Authorization: `Bearer ${WEAK}` },
      })
    ).json();
    assert.equal(lock.locked, true);
    assert.equal(lock.failures, Number(LIMIT));
  });

  it("NO successful sign-in clears the lock: loopback, magic-link exchange, known device", async () => {
    const locked = async () =>
      (
        await (
          await fetch(`http://127.0.0.1:${s.port}/api/auth/lock`, {
            headers: { Authorization: `Bearer ${WEAK}` },
          })
        ).json()
      ).locked;
    assert.equal(await locked(), true, "precondition: locked");
    // A loopback API call with the right token (the operator's CLI, a curl).
    assert.equal((await fromLoopback(s, WEAK)).status, 200);
    assert.equal(await locked(), true, "after a loopback request");
    // The sign-in link's exchange: POST /api/auth from this machine.
    const login = await fetch(`http://127.0.0.1:${s.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: WEAK }),
    });
    assert.equal(login.status, 200);
    assert.equal(await locked(), true, "after a magic-link sign-in");
    // Only an explicit unlock (CLI or the dashboard button) clears it.
  });

  it("the lock survives a restart", async () => {
    await s.kill();
    s = await boot({ token: WEAK, reuseConfigDir: s.configDir });
    assert.equal((await fromLan(s, WEAK)).status, 423);
  });

  it("`autonomos auth unlock` reopens it, and the device that then signs in is remembered", async () => {
    const res = spawnSync(TSX, [CLI_ENTRY, "auth", "unlock"], {
      env: {
        ...process.env,
        AUTONOMOS_CONFIG_DIR: s.configDir,
        AUTONOMOS_TOKEN: WEAK,
        HOME: s.fakeHome,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /New devices can sign in again/);
    assert.ok(!(res.stdout + res.stderr).includes(WEAK), "never the token");
    assert.equal(
      (await fromLan(s, WEAK)).status,
      200,
      "the LAN device signs in",
    );
    // Now known: a later lock never shuts it out.
    for (let i = 0; i < Number(LIMIT) + 2; i++) await fromLan(s, `typo-${i}`);
    assert.equal((await fromLan(s, WEAK)).status, 200, "known device stays in");
  });

  it("a STRONG token gets no lock: the same failures only meet the throttle", async () => {
    const strong = "0123456789abcdef".repeat(4);
    const t = await boot({ token: strong });
    for (let i = 0; i < Number(LIMIT) + 1; i++)
      assert.equal((await fromLan(t, `guess-${i}`)).status, 401);
    assert.equal((await fromLan(t, strong)).status, 200);
  });
});

/** Two global IPv6 addresses of this machine in the same /64 (SLAAC), or
 *  undefined. They stand in for the operator's laptop and a neighbor on the
 *  same Wi-Fi. */
function sameSlashSixtyFourPair(): [string, string] | undefined {
  const v6 = Object.values(networkInterfaces())
    .flat()
    .filter(
      (i) =>
        i &&
        i.family === "IPv6" &&
        !i.internal &&
        !i.address.toLowerCase().startsWith("fe80"),
    )
    .map((i) => i?.address as string);
  for (const a of v6)
    for (const b of v6)
      if (
        a !== b &&
        a.split(":").slice(0, 4).join(":") ===
          b.split(":").slice(0, 4).join(":")
      )
        return [a, b];
  return undefined;
}
const v6pair = sameSlashSixtyFourPair();

describe("new-device lock: an IPv6 neighbor isn't 'known' (#475)", {
  skip:
    !RUN_INTEGRATION || !v6pair
      ? "needs integration + two global IPv6 addresses in one /64"
      : false,
  timeout: 120_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("new-device-lock-v6", async () => {
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

  /** GET /api/agents from a chosen SOURCE address. */
  const fromV6 = (port: number, source: string, token: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: (v6pair as [string, string])[0],
          family: 6,
          port,
          path: "/api/agents",
          localAddress: source,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("the operator signs in from one address; a same-/64 neighbor still gets locked out", async () => {
    const [me, neighbor] = v6pair as [string, string];
    const saved = process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT;
    process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT = "3";
    let s: BootedServer;
    try {
      s = await bootServer({
        token: WEAK,
        prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")),
      });
    } finally {
      if (saved === undefined)
        delete process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT;
      else process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT = saved;
    }
    booted.push(s);
    assert.equal(await fromV6(s.port, me, WEAK), 200, "the operator's device");
    for (let i = 0; i < 3; i++) await fromV6(s.port, neighbor, `guess-${i}`);
    assert.equal(
      await fromV6(s.port, neighbor, WEAK),
      423,
      "the neighbor is a NEW device, even with the right token",
    );
    assert.equal(await fromV6(s.port, me, WEAK), 200, "the operator stays in");
  });
});
