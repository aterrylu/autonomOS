import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  _resetElectronForTesting,
  _setElectronForTesting,
} from "../electron-deps.js";
import {
  _resetForTesting,
  _setDependenciesForTesting,
  acquireOrConnect,
  getActiveServer,
} from "../server-supervisor.js";

/**
 * server-supervisor's acquireOrConnect() is THE highest-risk desktop logic:
 * it decides Built-in vs Always-on, and a wrong decision either (a) spawns a
 * duplicate server racing the operator's live daemon, or (b) fails to connect.
 *
 * SAFETY: every test injects a FAKE spawn — NO real process is ever created.
 * The pid-file / token are read from an ISOLATED temp dir (autonomosHome
 * override), so the operator's live ~/.autonomos is never touched.
 *
 * We assert the DECISION:
 *   - live owner present  → connect Always-on, NEVER spawn
 *   - no owner            → spawn Built-in, parse AUTONOMOS_READY port
 *   - child reports AUTONOMOS_ALREADY_RUNNING → Always-on (race), kill child
 *   - server exits before ready → reject cleanly
 *   - node binary missing → reject cleanly (no spawn attempted)
 */

let home: string; // isolated ~/.autonomos
let resources: string; // fake packaged Resources/ dir
let prevResourcesPath: string | undefined;

/** A fake ChildProcess: an EventEmitter with stdout/stderr emitters and a
 *  spy-able kill(). Mirrors only what acquireOrConnect consumes. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  killSignals: (string | number)[] = [];
  kill(signal?: string | number): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }
  emitStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
}

let lastChild: FakeChild | null = null;
let spawnCalls: { cmd: string; args: readonly string[] }[] = [];

/** Build a fake spawn that records every call and returns a FakeChild the
 *  test can drive. `onSpawn` lets a test schedule stdout/exit emissions. */
function makeFakeSpawn(
  onSpawn?: (child: FakeChild) => void,
): (cmd: string, args: readonly string[]) => FakeChild {
  return (cmd: string, args: readonly string[]) => {
    spawnCalls.push({ cmd, args });
    const child = new FakeChild();
    lastChild = child;
    // Defer so the caller can attach its stdout listeners first.
    queueMicrotask(() => onSpawn?.(child));
    return child;
  };
}

function writePidFile(contents: object): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "autonomos.pid"), JSON.stringify(contents));
}

function writeToken(token: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "token"), token);
}

/** Make findServerEntry()/findNodeBinary() succeed by faking a packaged app
 *  whose Resources/ contains the server bundle + a node binary. */
function installPackagedApp(): void {
  mkdirSync(join(resources, "server"), { recursive: true });
  writeFileSync(join(resources, "server", "index.js"), "// fake");
  mkdirSync(join(resources, "node", "bin"), { recursive: true });
  writeFileSync(join(resources, "node", "bin", "node"), "#!/bin/sh\n");
  prevResourcesPath = process.resourcesPath;
  // process.resourcesPath is undefined outside Electron; assign for the test.
  (process as { resourcesPath?: string }).resourcesPath = resources;
  _setElectronForTesting({
    app: { isPackaged: true, name: "autonomos-test", getPath: () => home },
  });
}

describe("acquireOrConnect — Built-in vs Always-on decision", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "autonomos-supervisor-home-"));
    resources = mkdtempSync(join(tmpdir(), "autonomos-supervisor-res-"));
    spawnCalls = [];
    lastChild = null;
    _setDependenciesForTesting({ autonomosHome: home });
  });

  afterEach(() => {
    _resetForTesting();
    _resetElectronForTesting();
    if (prevResourcesPath === undefined) {
      delete (process as { resourcesPath?: string }).resourcesPath;
    } else {
      (process as { resourcesPath?: string }).resourcesPath = prevResourcesPath;
    }
    prevResourcesPath = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(resources, { recursive: true, force: true });
  });

  it("connects to a live Always-on owner WITHOUT spawning", async () => {
    writePidFile({ pid: 4242, port: 5099, version: "9.9.9", startedAt: "t" });
    writeToken("existing-token");
    _setDependenciesForTesting({
      autonomosHome: home,
      isPidAlive: (pid) => pid === 4242,
      isPortResponsive: async () => true,
      // If anything spawns, blow up loudly.
      spawn: (() => {
        throw new Error("MUST NOT SPAWN when a live owner exists");
      }) as never,
    });
    _setElectronForTesting({
      app: { isPackaged: true, name: "t", getPath: () => home },
    });

    const server = await acquireOrConnect();
    assert.equal(server.mode, "always-on");
    assert.equal(server.port, 5099);
    assert.equal(server.token, "existing-token");
    if (server.mode === "always-on") assert.equal(server.pid, 4242);
    assert.equal(spawnCalls.length, 0, "must not spawn");
    assert.equal(getActiveServer(), server, "caches the active server");
  });

  it("does NOT connect to a stale owner whose pid is dead — falls through to spawn", async () => {
    writePidFile({ pid: 777, port: 5099, version: "1", startedAt: "t" });
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      isPidAlive: () => false, // pid is dead
      isPortResponsive: async () => true,
      spawn: makeFakeSpawn((c) =>
        c.emitStdout("AUTONOMOS_READY port=6001\n"),
      ) as never,
    });

    const server = await acquireOrConnect();
    assert.equal(server.mode, "built-in");
    assert.equal(spawnCalls.length, 1, "dead owner ⇒ Built-in spawn");
  });

  it("does NOT connect to an owner whose port is unresponsive — falls through to spawn", async () => {
    writePidFile({ pid: 4242, port: 5099, version: "1", startedAt: "t" });
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      isPidAlive: () => true,
      isPortResponsive: async () => false, // nothing listening
      spawn: makeFakeSpawn((c) =>
        c.emitStdout("AUTONOMOS_READY port=6002\n"),
      ) as never,
    });

    const server = await acquireOrConnect();
    assert.equal(server.mode, "built-in");
    assert.equal(spawnCalls.length, 1);
  });

  it("spawns Built-in and parses AUTONOMOS_READY port=N when no owner exists", async () => {
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      spawn: makeFakeSpawn((c) => {
        c.emitStdout("booting...\n");
        c.emitStdout("AUTONOMOS_READY port=6543\n");
      }) as never,
    });

    const server = await acquireOrConnect();
    assert.equal(server.mode, "built-in");
    assert.equal(server.port, 6543);
    assert.equal(spawnCalls.length, 1);
    // Spawned the bundled node against the bundled server entry, embedded mode.
    assert.equal(spawnCalls[0]?.cmd, join(resources, "node", "bin", "node"));
    assert.deepEqual(spawnCalls[0]?.args, [
      join(resources, "server", "index.js"),
      "--embedded",
      "--port=0",
    ]);
  });

  it("detects AUTONOMOS_ALREADY_RUNNING (startup race) → Always-on, kills the child", async () => {
    writeToken("shared-token");
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      spawn: makeFakeSpawn((c) =>
        c.emitStdout("AUTONOMOS_ALREADY_RUNNING port=5050 pid=9001\n"),
      ) as never,
    });

    const server = await acquireOrConnect();
    assert.equal(server.mode, "always-on");
    assert.equal(server.port, 5050);
    if (server.mode === "always-on") assert.equal(server.pid, 9001);
    assert.equal(server.token, "shared-token");
    // Belt-and-suspenders: our racing child must be killed.
    assert.ok(lastChild?.killed, "child must be SIGTERM'd on ALREADY_RUNNING");
  });

  it("rejects cleanly when the server exits before signaling ready", async () => {
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      spawn: makeFakeSpawn((c) => {
        c.exitCode = 1;
        c.emit("exit", 1, null);
      }) as never,
    });

    await assert.rejects(acquireOrConnect(), /exited before signaling ready/);
    assert.equal(getActiveServer(), null, "no active server after failure");
  });

  it("propagates a spawn 'error' event (e.g. ENOENT) as a rejection", async () => {
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      spawn: makeFakeSpawn((c) =>
        c.emit("error", new Error("spawn ENOENT")),
      ) as never,
    });

    await assert.rejects(acquireOrConnect(), /ENOENT/);
  });

  it("throws (no spawn) when the server bundle cannot be found", async () => {
    // Packaged app but Resources has no server/index.js.
    prevResourcesPath = process.resourcesPath;
    (process as { resourcesPath?: string }).resourcesPath = join(
      resources,
      "empty",
    );
    mkdirSync(join(resources, "empty"), { recursive: true });
    _setElectronForTesting({
      app: { isPackaged: true, name: "t", getPath: () => home },
    });
    _setDependenciesForTesting({
      autonomosHome: home,
      spawn: (() => {
        throw new Error("must not reach spawn");
      }) as never,
    });

    await assert.rejects(acquireOrConnect(), /Server bundle not found/);
    assert.equal(spawnCalls.length, 0);
  });

  it("ignores stdout AFTER it has resolved (no double-resolve / late re-parse)", async () => {
    installPackagedApp();
    _setDependenciesForTesting({
      autonomosHome: home,
      spawn: makeFakeSpawn((c) => {
        c.emitStdout("AUTONOMOS_READY port=7000\n");
        // Late chatter that also matches must be ignored.
        c.emitStdout("AUTONOMOS_READY port=8000\n");
        c.emitStdout("AUTONOMOS_ALREADY_RUNNING port=1 pid=1\n");
      }) as never,
    });

    const server = await acquireOrConnect();
    assert.equal(server.port, 7000, "first READY wins; later lines ignored");
    assert.equal(server.mode, "built-in");
  });
});
