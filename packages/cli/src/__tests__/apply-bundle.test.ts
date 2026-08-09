// Health gate (apply-bundle.ts) — the post-swap boot verification that
// decides whether `autonomos upgrade` reports success or auto-rolls back.
// Both failure directions are silent in production (an unnecessary rollback
// of a working daemon, or a missing rollback of a broken one), so the
// true/false split is pinned here against a REAL pid file and a REAL local
// HTTP listener. The e2e script can't reach this code: under its isolated
// HOME there is no supervisor, so every upgrade takes the not-running branch.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "@autonomos/server/configDir.js";
import { writePidFile } from "@autonomos/server/pid-file.js";
import {
  expectedVersionAfterSwap,
  verifyDaemonVersion,
} from "../lib/apply-bundle.js";

let cfgDir: string;
let server: Server | undefined;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "autonomos-apply-bundle-"));
  _setConfigDirForTesting(cfgDir);
});

afterEach(async () => {
  _resetConfigDirForTesting();
  rmSync(cfgDir, { recursive: true, force: true });
  if (server) {
    await new Promise((r) => server?.close(r));
    server = undefined;
  }
});

async function listenOnEphemeralPort(): Promise<number> {
  server = createServer((_req, res) => {
    res.end("{}");
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const addr = server?.address();
  if (!addr || typeof addr !== "object") throw new Error("no port");
  return addr.port;
}

function writePid(version: string, port: number, pid = process.pid): void {
  writePidFile({ pid, port, version, startedAt: new Date().toISOString() });
}

/** A pid that is genuinely dead: spawn a no-op child and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn("true");
  const pid = child.pid;
  if (!pid) throw new Error("no child pid");
  await new Promise((r) => child.on("exit", r));
  return pid;
}

describe("verifyDaemonVersion", () => {
  it("true when the pid file carries the expected version, the pid is alive, and the port answers", async () => {
    const port = await listenOnEphemeralPort();
    writePid("1.2.3", port);
    assert.equal(await verifyDaemonVersion("1.2.3", 5_000), true);
  });

  it("false when the pid file carries a DIFFERENT version (old daemon still up)", async () => {
    const port = await listenOnEphemeralPort();
    writePid("1.0.0", port);
    assert.equal(await verifyDaemonVersion("1.2.3", 1_500), false);
  });

  it("false when no pid file exists", async () => {
    assert.equal(await verifyDaemonVersion("1.2.3", 1_500), false);
  });

  it("false when the recorded pid is dead even if the version matches", async () => {
    const port = await listenOnEphemeralPort();
    writePid("1.2.3", port, await deadPid());
    assert.equal(await verifyDaemonVersion("1.2.3", 1_500), false);
  });

  it("false when the version matches but nothing listens on the port", async () => {
    // Port 1 on loopback: connection refused. No fixture server started.
    writePid("1.2.3", 1);
    assert.equal(await verifyDaemonVersion("1.2.3", 1_500), false);
  });
});

describe("expectedVersionAfterSwap", () => {
  let bundleRoot: string;
  beforeEach(() => {
    bundleRoot = mkdtempSync(join(tmpdir(), "autonomos-bundle-ver-"));
  });
  after(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  it("gates on the bundle's actual package.json when it disagrees with the tag", () => {
    const bundleDir = join(bundleRoot, "share", "autonomos");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, "package.json"),
      JSON.stringify({ name: "@autonomos/server", version: "9.9.9" }),
    );
    assert.equal(expectedVersionAfterSwap(bundleDir, "1.0.0"), "9.9.9");
  });

  it("falls back to the tag when the bundle version is unreadable", () => {
    const emptyDir = join(bundleRoot, "empty");
    mkdirSync(emptyDir, { recursive: true });
    assert.equal(expectedVersionAfterSwap(emptyDir, "1.0.0"), "1.0.0");
  });
});
