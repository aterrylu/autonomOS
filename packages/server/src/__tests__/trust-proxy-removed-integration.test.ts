import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
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
 * L3 (AUTONOMOS_INTEGRATION=1): the tailscale serve trust-proxy mode is gone
 * (ADR-157). A leftover setting refuses to start, loudly. Proxy headers from
 * loopback TCP never become an identity: the device is the TCP peer.
 */

const WEAK = "QZXJ";

function get(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path, headers },
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
    r.end();
  });
}

describe("trust-proxy removed (ADR-157)", {
  skip: !RUN_INTEGRATION,
  timeout: 180_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("trust-proxy-removed", async () => {
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

  const expectRefused = async (
    opts: Parameters<typeof bootServer>[0],
  ): Promise<Error> => {
    let s: BootedServer | undefined;
    try {
      s = await bootServer(opts);
    } catch (err) {
      return err as Error;
    }
    booted.push(s);
    assert.fail("the server started; a leftover --trust-proxy must refuse");
  };

  it("a leftover --trust-proxy flag refuses to start, saying what to do instead", async () => {
    const err = await expectRefused({
      token: WEAK,
      extraArgs: ["--host=127.0.0.1", "--trust-proxy=tailscale"],
      prepareConfigDir: (d) => mkdirSync(join(d, "templates")),
    });
    assert.match(err.message, /exited \(code=2\)/);
    assert.match(err.message, /--trust-proxy was removed/);
    assert.match(
      err.message,
      /--host=127\.0\.0\.1,<this machine's tailnet IP>/,
    );
    assert.match(err.message, /tailscale serve reset/);
  });

  it("…and so does a leftover AUTONOMOS_TRUST_PROXY", async () => {
    const err = await expectRefused({
      token: WEAK,
      extraArgs: ["--host=127.0.0.1"],
      env: { AUTONOMOS_TRUST_PROXY: "tailscale" },
      prepareConfigDir: (d) => mkdirSync(join(d, "templates")),
    });
    assert.match(err.message, /exited \(code=2\)/);
    assert.match(err.message, /AUTONOMOS_TRUST_PROXY/);
  });

  it("forged proxy headers from loopback TCP never become an identity (the device is the TCP peer)", async () => {
    const s = await bootServer({
      token: WEAK,
      extraArgs: ["--host=127.0.0.1"],
      env: { AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT: "3" },
      prepareConfigDir: (d) => mkdirSync(join(d, "templates")),
    });
    booted.push(s);
    const forged = {
      "X-Forwarded-For": "100.64.1.2",
      "Tailscale-User-Login": "mallory@example.com",
    };
    // As a "tailnet device" these would lock new devices after 3; as this
    // machine (loopback, exempt) they count for nothing.
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await get(s.port, "/api/agents", {
            ...forged,
            Authorization: `Bearer wrong-${i}`,
          })
        ).status,
        401,
      );
    const lock = JSON.parse(
      (
        await get(s.port, "/api/auth/lock", {
          Authorization: `Bearer ${WEAK}`,
        })
      ).body,
    );
    assert.equal(lock.locked, false, "no lock from forged tailnet devices");
    assert.equal(lock.failures, 0, "loopback failures are never counted");
    assert.equal(lock.lastFailureFrom, null, "never 100.64.1.2");
    assert.equal(lock.trustProxy, undefined, "the mode is gone from the API");
    assert.equal(lock.lastFailureLogin, undefined);
  });
});
