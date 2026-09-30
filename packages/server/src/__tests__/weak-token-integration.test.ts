import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

/** Warnings and errors go to the log file (stderr is echoed only on a TTY). */
function logFile(configDir: string): string {
  const p = join(configDir, "logs", "autonomos.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("weak operator token at boot", {
  skip: !RUN_INTEGRATION,
  timeout: 120_000,
}, () => {
  const booted: BootedServer[] = [];
  after(() =>
    boundedTeardown("weak-token", async () => {
      // Stop EVERY server first, then remove dirs with retries (a server still
      // flushing its log as it exits makes rm race: ENOTEMPTY). One failure
      // must never skip the rest: a skipped kill holds the runner open.
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
  /** Boot and expect a refusal (exit 2). A boot that unexpectedly SUCCEEDS is
   *  registered for teardown before failing, so a regression fails the test
   *  instead of leaving a live server that holds the runner open. */
  const expectRefused = async (
    opts: Parameters<typeof bootServer>[0],
  ): Promise<Error> => {
    let started: BootedServer | undefined;
    try {
      started = await bootServer(opts);
    } catch (err) {
      return err as Error;
    }
    booted.push(started);
    assert.fail("the server started; it should have refused");
  };
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
    const log = logFile(s.configDir);
    assert.match(
      log,
      /SECURITY: the operator token .* is weak \(4 characters\)/,
    );
    assert.match(log, /autonomos token rotate/);
    assert.ok(!log.includes(WEAK), "never the token in the log");
    assert.ok(!s.logs().includes(WEAK), "never the token on stdout");
  });

  it("a NEW install on a network bind refuses to start, without printing the token", async () => {
    let dir = "";
    const err = await expectRefused({
      token: WEAK,
      prepareConfigDir: (d) => (dir = d),
    });
    assert.match(err.message, /exited \(code=2\)/);
    assert.ok(!err.message.includes(WEAK), "never the token");
    // The reason is in the log a supervised install keeps.
    const log = logFile(dir);
    assert.match(log, /Refusing to start/);
    assert.match(log, /--allow-weak-token/);
    assert.ok(!log.includes(WEAK), "never the token");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an IDENTICAL second attempt is refused again (a refused boot leaves no install marker)", async () => {
    let dir = "";
    const first = await expectRefused({
      token: WEAK,
      prepareConfigDir: (d) => (dir = d),
    });
    assert.match(first.message, /exited \(code=2\)/);
    assert.ok(dir, "captured the config dir");
    const second = await expectRefused({ token: WEAK, reuseConfigDir: dir });
    assert.match(second.message, /exited \(code=2\)/, "still refused");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the warning never reaches an unauthenticated response", async () => {
    const s = await bootServer({
      token: WEAK,
      prepareConfigDir: (dir) => mkdirSync(join(dir, "templates")),
    });
    booted.push(s);
    const base = `http://127.0.0.1:${s.port}`;
    const v = await fetch(`${base}/api/system/version`);
    assert.equal(v.status, 401);
    assert.ok(!(await v.text()).includes("tokenWarning"));
    const h = await fetch(`${base}/api/host`);
    assert.equal(h.status, 200, "the one public route");
    const host = await h.text();
    assert.ok(!/tokenWarning|weak/i.test(host), host);
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
