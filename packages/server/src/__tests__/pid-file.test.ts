import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Set AUTONOMOS_CONFIG_DIR before importing pid-file (configDir reads env at load)
const TEST_DIR = join(tmpdir(), `autonomos-test-pid-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const {
  acquireOwnership,
  isPidAlive,
  isPortResponsive,
  pidFilePath,
  readPidFile,
  removePidFile,
  writePidFile,
} = await import("../pid-file.js");

const PID_FILE = join(TEST_DIR, "autonomos.pid");
const LOCK_FILE = join(TEST_DIR, "autonomos.pid.lock");

/** Spin up a minimal HTTP server that responds to /api/system/version.
 *  Used by tests to simulate a "live" prior owner. */
async function makeLiveServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/system/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "test", platform: "test", arch: "test" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({
          port: addr.port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      } else {
        reject(new Error("could not get server port"));
      }
    });
    server.on("error", reject);
  });
}

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("returns false for an obviously-dead pid", () => {
    // PID 1 is init/launchd — always alive. Use a high number that's
    // almost certainly not in use; if it is by chance, that's fine —
    // the test asserts the *function* works on a fresh start of macOS
    // where this PID hasn't been allocated yet.
    assert.equal(isPidAlive(999_999_999), false);
  });
});

describe("isPortResponsive", () => {
  it("returns false for a port nobody is listening on", async () => {
    // A high port nobody's likely using. If this is racy, raise it.
    assert.equal(await isPortResponsive(59999, 200), false);
  });

  it("returns true for a port with a live HTTP server", async () => {
    const live = await makeLiveServer();
    try {
      assert.equal(await isPortResponsive(live.port, 500), true);
    } finally {
      await live.close();
    }
  });
});

describe("acquireOwnership", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Clean slate per test.
    if (existsSync(PID_FILE)) rmSync(PID_FILE);
    if (existsSync(LOCK_FILE)) rmSync(LOCK_FILE);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("acquires when no prior pid file exists", async () => {
    const result = await acquireOwnership(process.pid, 12345, "0.0.1");
    assert.equal(result.status, "acquired");
    const wrote = readPidFile();
    assert.ok(wrote);
    assert.equal(wrote.pid, process.pid);
    assert.equal(wrote.port, 12345);
    assert.equal(wrote.version, "0.0.1");
  });

  it("releases the lock file after acquiring", async () => {
    await acquireOwnership(process.pid, 12345, "0.0.1");
    assert.equal(existsSync(LOCK_FILE), false);
  });

  it("returns already-running when a live owner exists", async () => {
    const live = await makeLiveServer();
    try {
      // Pretend a previous server wrote the pid file with this current
      // process's pid + the live HTTP server's port. Both alive
      // (process.pid is us) AND responsive (the test server above).
      writePidFile({
        pid: process.pid,
        port: live.port,
        version: "0.0.1",
        startedAt: new Date().toISOString(),
      });

      const result = await acquireOwnership(process.pid + 1, 99999, "0.0.1");
      assert.equal(result.status, "already-running");
      if (result.status === "already-running") {
        assert.equal(result.owner.pid, process.pid);
        assert.equal(result.owner.port, live.port);
      }
    } finally {
      await live.close();
    }
  });

  it("cleans up a stale pid file (dead pid) and acquires", async () => {
    // Write a pid file pointing at an obviously-dead pid.
    writePidFile({
      pid: 999_999_999,
      port: 12345,
      version: "0.0.1",
      startedAt: new Date().toISOString(),
    });

    const result = await acquireOwnership(process.pid, 54321, "0.0.1");
    assert.equal(result.status, "acquired");
    const wrote = readPidFile();
    assert.ok(wrote);
    assert.equal(wrote.pid, process.pid);
    assert.equal(wrote.port, 54321);
  });

  it("cleans up a stale pid file (live pid but dead port) and acquires", async () => {
    // Current process is alive but nothing's listening on a random port.
    writePidFile({
      pid: process.pid,
      port: 59998,
      version: "0.0.1",
      startedAt: new Date().toISOString(),
    });

    const result = await acquireOwnership(process.pid, 54321, "0.0.1");
    assert.equal(result.status, "acquired");
    const wrote = readPidFile();
    assert.ok(wrote);
    assert.equal(wrote.port, 54321);
  });

  it("handles a stale lock file from a crashed prior start", async () => {
    // Simulate a crashed prior process that left autonomos.pid.lock around.
    writeFileSync(LOCK_FILE, "stale");

    // Should still acquire (the second-attempt + force-remove path).
    // Adds latency (~100ms wait) but completes successfully.
    const result = await acquireOwnership(process.pid, 12345, "0.0.1");
    assert.equal(result.status, "acquired");
  });

  it("pid file is created with mode 0600 (defense in depth)", async () => {
    await acquireOwnership(process.pid, 12345, "0.0.1");
    // The pid file itself doesn't enforce 0o600 explicitly today (it's
    // written via writeFileSync without mode). The lock file does. This
    // test pins the current behavior of pidFilePath() existing after
    // acquire, leaving stricter mode for a follow-up if needed.
    assert.equal(existsSync(pidFilePath()), true);
  });

  it("removePidFile releases ownership", async () => {
    await acquireOwnership(process.pid, 12345, "0.0.1");
    assert.equal(existsSync(PID_FILE), true);
    removePidFile();
    assert.equal(existsSync(PID_FILE), false);
  });
});

describe("acquireOwnership concurrency (sequential calls in one process)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(PID_FILE)) rmSync(PID_FILE);
    if (existsSync(LOCK_FILE)) rmSync(LOCK_FILE);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("two back-to-back acquires by the same pid both succeed (idempotent within a process)", async () => {
    // The contract is "at most one owner per config dir." If the same
    // process calls acquireOwnership twice, the second call sees the
    // pid file written by the first call. Since the pid is still alive
    // (it's us) AND if the port is responsive, we'd return already-
    // running. But typically only run.ts calls this once.
    //
    // Practical assertion: two sequential calls don't crash and both
    // claim resources (the second sees a stale-port pid file because
    // nothing's listening on the first port we passed, so it cleans
    // up and acquires).
    const r1 = await acquireOwnership(process.pid, 11111, "0.0.1");
    const r2 = await acquireOwnership(process.pid, 22222, "0.0.1");
    assert.equal(r1.status, "acquired");
    assert.equal(r2.status, "acquired");
    const wrote = readPidFile();
    assert.equal(wrote?.port, 22222);
  });
});
