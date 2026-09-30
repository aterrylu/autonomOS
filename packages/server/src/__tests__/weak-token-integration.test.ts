import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  type BootedServer,
  bootServer,
  boundedTeardown,
  RUN_INTEGRATION,
} from "./helpers/test-server.js";

/**
 * L3 integration (AUTONOMOS_INTEGRATION=1), V2b. A real server with a weak
 * operator token:
 *   - an EXISTING install (config dir used before) always starts, still
 *     authenticates with that token (upgrades never break auth), warns in the
 *     boot log, and reports it to the dashboard via /api/system/version;
 *   - a NEW install on a network bind refuses to start (exit 2, the token
 *     never printed), unless --allow-weak-token or a loopback --host;
 *   - a strong token reports nothing.
 */

const WEAK = "QZXJ";

describe("weak operator token at boot", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("weak-token", async () => {
      for (const s of booted) {
        await s.kill();
        rmSync(s.configDir, { recursive: true, force: true });
      }
    }),
  );
  const version = async (s: BootedServer, token: string) => {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/system/version`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json() };
  };

  it("an EXISTING install starts, still authenticates, warns and reports it", async () => {
    const s = await bootServer({
      token: WEAK,
      // Used before this boot: an agents/ dir from an earlier version.
      prepareConfigDir: (dir) => mkdirSync(join(dir, "agents")),
    });
    booted.push(s);
    const v = await version(s, WEAK);
    assert.equal(v.status, 200, "the weak token still works");
    assert.deepEqual(v.body.tokenWarning, {
      length: 4,
      source: "env",
      networkBind: true,
    });
    assert.match(
      s.logs(),
      /SECURITY: the operator token .* is weak \(4 characters\)/,
    );
    assert.match(s.logs(), /autonomos token rotate/);
    assert.ok(!s.logs().includes(WEAK), "never the token");
  });

  it("a NEW install on a network bind refuses to start, without printing the token", async () => {
    await assert.rejects(
      () => bootServer({ token: WEAK }),
      (err: Error) => {
        assert.match(err.message, /exited \(code=2\)/);
        assert.match(err.message, /Refusing to start/);
        assert.match(err.message, /--allow-weak-token/);
        assert.ok(!err.message.includes(WEAK), "never the token");
        return true;
      },
    );
  });

  it("…starts with --allow-weak-token, warning", async () => {
    const s = await bootServer({
      token: WEAK,
      extraArgs: ["--allow-weak-token"],
    });
    booted.push(s);
    assert.equal((await version(s, WEAK)).body.tokenWarning.networkBind, true);
  });

  it("…starts on a loopback bind, warning", async () => {
    const s = await bootServer({
      token: WEAK,
      extraArgs: ["--host=127.0.0.1"],
    });
    booted.push(s);
    assert.equal((await version(s, WEAK)).body.tokenWarning.networkBind, false);
  });

  it("a strong token reports nothing", async () => {
    const strong = "0123456789abcdef".repeat(4);
    const s = await bootServer({ token: strong });
    booted.push(s);
    assert.equal((await version(s, strong)).body.tokenWarning, null);
    assert.ok(!s.logs().includes("SECURITY: the operator token"));
  });
});
