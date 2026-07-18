import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import {
  assertUsableSocketPath,
  getControlSocketPath,
  prepareControlSocket,
  probeControlSocket,
  removeControlSocket,
  restrictControlSocket,
} from "../internalSocket.js";

// Socket paths are bounded by sockaddr_un.sun_path (~104 bytes), so test dirs
// must stay SHORT — a long mkdtemp path under macOS's /var/folders/... would
// blow the limit and fail these tests for a reason unrelated to what they test.
const TEST_ROOT = join(tmpdir(), "aos-sock-t");

let counter = 0;
/** Unique short socket path per test. */
function socketPath(): string {
  counter += 1;
  return join(TEST_ROOT, `c${counter}.sock`);
}

/** Bind a real listener so the probe has something live to find. */
async function listenOn(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Leave behind a genuinely stale socket: bind it in a CHILD process, then
 * SIGKILL that child so it never gets to unlink.
 *
 * Writing a regular file at the path would NOT reproduce this — connect() to a
 * regular file doesn't answer ECONNREFUSED, so it exercises a different branch
 * entirely (that's `not-a-socket`). Only a real orphaned socket inode proves
 * the crash-recovery path works.
 */
async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(path)}, () => {
         process.stdout.write("bound\\n");
       });
       setTimeout(() => {}, 60000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child never bound the socket")),
      10_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("bound")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });

  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  _resetConfigDirForTesting();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("getControlSocketPath", () => {
  it("derives from the active config dir, so an isolated dir is an isolated socket", () => {
    _setConfigDirForTesting("/tmp/aos-isolated");
    assert.equal(getControlSocketPath(), "/tmp/aos-isolated/control.sock");
  });
});

describe("assertUsableSocketPath", () => {
  it("accepts an ordinary path", () => {
    assert.doesNotThrow(() =>
      assertUsableSocketPath("/Users/x/.autonomos/control.sock"),
    );
  });

  // Forward defense for PR B (nothing dials ws+unix: today): when the gateway
  // moves onto this socket, the ws client will split the URL on the first ':',
  // so a colon in the path would truncate it. Rejecting it now means PR B can't
  // inherit a config dir that was already quietly incompatible.
  it("rejects a path containing a colon", () => {
    assert.throws(
      () => assertUsableSocketPath("/tmp/weird:dir/control.sock"),
      /contains ":"/,
    );
  });

  it("rejects a path past the OS sun_path limit", () => {
    const tooLong = `/tmp/${"d".repeat(120)}/control.sock`;
    assert.throws(
      () => assertUsableSocketPath(tooLong),
      /limit for Unix socket/,
    );
  });
});

describe("probeControlSocket", () => {
  it("reports absent when nothing is there", async () => {
    assert.equal(await probeControlSocket(socketPath()), "absent");
  });

  it("reports live when a server is accepting", async () => {
    const path = socketPath();
    const server = await listenOn(path);
    try {
      assert.equal(await probeControlSocket(path), "live");
    } finally {
      await closeServer(server);
    }
  });

  // The crash case: a socket file outlives the process that bound it, so the
  // file exists but nothing accepts. This is what makes unconditional unlink
  // unsafe and the probe necessary. It is also a routine dev-mode occurrence —
  // `make dev` under tsx tears the child down before its SIGTERM handler
  // finishes unlinking.
  it("reports stale for a socket whose owner was killed", async () => {
    const path = socketPath();
    await leaveStaleSocket(path);
    assert.equal(existsSync(path), true, "SIGKILL should leave the inode");
    assert.equal(await probeControlSocket(path), "stale");
  });

  // A regular file is NOT a dead socket: connect() doesn't answer ECONNREFUSED
  // for it, so folding it into "live" would report a phantom running server.
  it("distinguishes a non-socket file from a live server", async () => {
    const path = join(TEST_ROOT, "plain.sock");
    writeFileSync(path, "definitely not a socket");
    assert.equal(await probeControlSocket(path), "not-a-socket");
  });
});

describe("prepareControlSocket", () => {
  it("is a no-op when the path is free", async () => {
    const path = socketPath();
    await prepareControlSocket(path);
    assert.equal(existsSync(path), false);
  });

  it("unlinks a stale socket so the next bind succeeds", async () => {
    const path = socketPath();
    await leaveStaleSocket(path);
    assert.equal(existsSync(path), true);

    await prepareControlSocket(path);
    assert.equal(existsSync(path), false);

    // The point of the unlink: the path is bindable again.
    const server = await listenOn(path);
    await closeServer(server);
  });

  it("refuses to delete a non-socket file it did not create", async () => {
    const path = join(TEST_ROOT, "stray.sock");
    writeFileSync(path, "someone else's file");
    await assert.rejects(() => prepareControlSocket(path), /is not a socket/);
    assert.equal(existsSync(path), true, "must not delete an unknown file");
  });

  // The PR #172 failure mode: a second server must not steal a live server's
  // socket, because pid-file mutual exclusion has not run yet at this point.
  it("refuses to steal a socket a live server owns", async () => {
    const path = socketPath();
    const server = await listenOn(path);
    try {
      await assert.rejects(
        () => prepareControlSocket(path),
        /Another autonomos-server is already serving/,
      );
      assert.equal(existsSync(path), true, "live socket must survive");
    } finally {
      await closeServer(server);
    }
  });
});

describe("restrictControlSocket", () => {
  it("narrows the bound socket to owner-only", async () => {
    const path = socketPath();
    const server = await listenOn(path);
    try {
      restrictControlSocket(path);
      const { statSync } = await import("node:fs");
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      await closeServer(server);
    }
  });
});

describe("removeControlSocket", () => {
  it("removes the socket file", async () => {
    const path = socketPath();
    await leaveStaleSocket(path);
    removeControlSocket(path);
    assert.equal(existsSync(path), false);
  });

  it("tolerates an already-absent socket during shutdown", () => {
    assert.doesNotThrow(() => removeControlSocket(socketPath()));
  });
});
