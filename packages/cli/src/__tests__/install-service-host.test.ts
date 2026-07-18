import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _setConfigDirForTesting } from "@autonomos/server/configDir.js";
import { runInstallServiceCommand } from "../commands/install-service.js";
import { getServicePaths } from "../lib/service-paths.js";

/**
 * --host must survive into the written service file.
 *
 * This is the piece that keeps a deliberately-exposed box working across the
 * loopback-default change. `install-prod-service.sh` previously passed only
 * --port, so once the server started defaulting to loopback, the next
 * `make deploy` would have silently rebound a remote always-on server to
 * 127.0.0.1 and cut off browser access — an outage caused by the security fix.
 *
 * Hermetic on two axes, both load-bearing:
 *  • --prefix + --no-activate keep the service file in a temp dir and skip
 *    launchctl/systemctl, so nothing is installed on the host.
 *  • _setConfigDirForTesting redirects the CONFIG DIR. Without it, install-service's
 *    ADR-029 pid-file check reads the operator's REAL ~/.autonomos, finds their
 *    live daemon, and returns 1 — the suite fails on a developer machine for a
 *    reason that has nothing to do with the code under test.
 */

describe("install-service --host threading", () => {
  let prefix: string;
  let configDir: string;

  beforeEach(() => {
    prefix = mkdtempSync(join(tmpdir(), "autonomos-svc-"));
    configDir = mkdtempSync(join(tmpdir(), "autonomos-cfg-"));
    _setConfigDirForTesting(configDir);
  });

  afterEach(() => {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const serviceFile = (): string => getServicePaths(prefix).serviceFile;

  const install = (extra: string[]): Promise<number> =>
    runInstallServiceCommand([
      "--no-activate",
      `--prefix=${prefix}`,
      "--bin=/fake/autonomos",
      "--port=3100",
      ...extra,
    ]);

  it("bakes --host into the service file when given", async () => {
    assert.equal(await install(["--host=0.0.0.0"]), 0);
    assert.match(readFileSync(serviceFile(), "utf-8"), /--host=0\.0\.0\.0/);
  });

  it("omits --host entirely when not given, leaving the server's default", async () => {
    // Absence matters: writing --host= or --host=127.0.0.1 here would either
    // widen the bind or hard-code a default the server should own.
    assert.equal(await install([]), 0);
    const written = readFileSync(serviceFile(), "utf-8");
    assert.ok(!written.includes("--host"), "no --host should be emitted");
    assert.match(written, /--port=3100/, "--port must still be threaded");
  });

  it("rejects an empty --host rather than writing it into the unit", async () => {
    // A service file carrying `--host=` would re-expose the port on every boot.
    // The command reports usage errors as exit 64 rather than throwing.
    assert.equal(await install(["--host="]), 64);
  });
});
