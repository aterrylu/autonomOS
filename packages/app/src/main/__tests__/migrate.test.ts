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
  _resetMigrateForTesting,
  _setMigrateDependenciesForTesting,
  migrateToAlwaysOn,
  migrateToBuiltIn,
} from "../migrate.js";
import { _resetForTesting } from "../server-supervisor.js";

/**
 * migrate.ts flips between Built-in and Always-on by shelling out to the
 * bundled CLI's install-service / uninstall-service. We unit-test the
 * orchestration WITHOUT creating a process:
 *   - the right CLI subcommand is invoked
 *   - exit code 0 ⇒ ok:true; non-zero ⇒ ok:false; both capture stdout/stderr
 *   - a spawn 'error' event surfaces as ok:false with the message
 *   - a missing CLI bundle ⇒ ok:false, "CLI bundle not found", no spawn
 */

let resources: string;
let prevResourcesPath: string | undefined;
let spawnCalls: { cmd: string; args: readonly string[] }[] = [];

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function makeFakeSpawn(
  drive: (p: FakeProc) => void,
): (cmd: string, args: readonly string[]) => FakeProc {
  return (cmd, args) => {
    spawnCalls.push({ cmd, args });
    const p = new FakeProc();
    queueMicrotask(() => drive(p));
    return p;
  };
}

function installCliBundle(): void {
  mkdirSync(join(resources, "server"), { recursive: true });
  writeFileSync(join(resources, "server", "index.js"), "// fake cli");
  prevResourcesPath = process.resourcesPath;
  (process as { resourcesPath?: string }).resourcesPath = resources;
  _setElectronForTesting({
    app: { isPackaged: true, name: "t", getPath: () => resources },
  });
}

describe("migrate (Built-in ↔ Always-on)", () => {
  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), "autonomos-migrate-res-"));
    spawnCalls = [];
    _setMigrateDependenciesForTesting({ settleDelayMs: 0 });
  });

  afterEach(() => {
    _resetMigrateForTesting();
    _resetElectronForTesting();
    _resetForTesting(); // clears any cached active server touched by shutdown
    if (prevResourcesPath === undefined) {
      delete (process as { resourcesPath?: string }).resourcesPath;
    } else {
      (process as { resourcesPath?: string }).resourcesPath = prevResourcesPath;
    }
    prevResourcesPath = undefined;
    rmSync(resources, { recursive: true, force: true });
  });

  it("migrateToAlwaysOn runs `install-service` and returns ok on exit 0", async () => {
    installCliBundle();
    _setMigrateDependenciesForTesting({
      settleDelayMs: 0,
      spawn: makeFakeSpawn((p) => {
        p.stdout.emit("data", Buffer.from("service installed\n"));
        p.emit("close", 0);
      }) as never,
    });

    const result = await migrateToAlwaysOn();
    assert.equal(result.ok, true);
    assert.match(result.stdout, /service installed/);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0]?.args, [
      join(resources, "server", "index.js"),
      "install-service",
    ]);
  });

  it("migrateToBuiltIn runs `uninstall-service` and returns ok on exit 0", async () => {
    installCliBundle();
    _setMigrateDependenciesForTesting({
      settleDelayMs: 0,
      spawn: makeFakeSpawn((p) => {
        p.emit("close", 0);
      }) as never,
    });

    const result = await migrateToBuiltIn();
    assert.equal(result.ok, true);
    assert.deepEqual(spawnCalls[0]?.args, [
      join(resources, "server", "index.js"),
      "uninstall-service",
    ]);
  });

  it("reports ok:false and captures stderr on a non-zero exit", async () => {
    installCliBundle();
    _setMigrateDependenciesForTesting({
      settleDelayMs: 0,
      spawn: makeFakeSpawn((p) => {
        p.stderr.emit("data", Buffer.from("permission denied\n"));
        p.emit("close", 13);
      }) as never,
    });

    const result = await migrateToAlwaysOn();
    assert.equal(result.ok, false);
    assert.match(result.stderr, /permission denied/);
  });

  it("surfaces a spawn 'error' event as ok:false with the message", async () => {
    installCliBundle();
    _setMigrateDependenciesForTesting({
      settleDelayMs: 0,
      spawn: makeFakeSpawn((p) => {
        p.emit("error", new Error("spawn ENOENT"));
      }) as never,
    });

    const result = await migrateToAlwaysOn();
    assert.equal(result.ok, false);
    assert.match(result.stderr, /ENOENT/);
  });

  it("returns 'CLI bundle not found' (no spawn) when the bundle is missing", async () => {
    // Packaged, but Resources has no server/index.js.
    prevResourcesPath = process.resourcesPath;
    (process as { resourcesPath?: string }).resourcesPath = join(
      resources,
      "nope",
    );
    _setElectronForTesting({
      app: { isPackaged: true, name: "t", getPath: () => resources },
    });
    _setMigrateDependenciesForTesting({
      settleDelayMs: 0,
      spawn: (() => {
        throw new Error("must not spawn");
      }) as never,
    });

    const result = await migrateToAlwaysOn();
    assert.equal(result.ok, false);
    assert.match(result.stderr, /CLI bundle not found/);
    assert.equal(spawnCalls.length, 0);
  });

  it("migrateToBuiltIn does NOT settle-delay when uninstall fails", async () => {
    // If uninstall returns non-zero, the cache is NOT cleared and there's no
    // delay — assert ok:false propagates (behavior pin).
    installCliBundle();
    _setMigrateDependenciesForTesting({
      settleDelayMs: 0,
      spawn: makeFakeSpawn((p) => {
        p.stderr.emit("data", Buffer.from("not installed\n"));
        p.emit("close", 1);
      }) as never,
    });

    const result = await migrateToBuiltIn();
    assert.equal(result.ok, false);
    assert.match(result.stderr, /not installed/);
  });
});
