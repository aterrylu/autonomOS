import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
 * L3 integration (AUTONOMOS_INTEGRATION=1): the new-device lock (ADR-133) on a
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
