/**
 * A WebSocket client that vanishes mid-handshake must not crash the server.
 *
 * Found by OrgChart on an isolated server: ~7 rapid agent kills with a
 * dashboard open crashed the process with an unhandled EPIPE from
 * @hono/node-ws's upgrade handler (`socket.end()` on a refused upgrade whose
 * peer was already gone), taking every live agent's PTY with it. See
 * upgradeSockets.ts. The real-socket cases run in a CHILD process because,
 * unfixed, they really do crash the process; the EPIPE-from-end() case is
 * pinned in-process with a socket whose write fails deterministically.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { attachWebSockets } from "../upgradeSockets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "upgrade-vanish-child.ts");

function run(mode: "raw" | "guarded") {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
      // tsx resolves from the server package, not the repo root.
      cwd: join(HERE, "..", ".."),
      env: { PATH: process.env.PATH, MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const append = (d: Buffer) => {
      out += d;
    };
    c.stdout.on("data", append);
    c.stderr.on("data", append);
    const kill = setTimeout(() => c.kill("SIGKILL"), 20_000);
    c.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
  });
}

describe("upgrade socket: a client that vanishes mid-handshake", () => {
  it("the fixture reproduces the crash when node-ws is wired directly (the bug)", async () => {
    const { code, out } = await run("raw");
    assert.ok(out.includes("READY"), out);
    assert.notEqual(code, 0, "unguarded: the process crashes");
    assert.ok(!out.includes("ALIVE"), out);
    // The RST is read during node-ws's async window (see the fixture header).
    assert.match(out, /Unhandled 'error' event[\s\S]*ECONNRESET/, out);
  });

  it("through attachWebSockets the server stays alive", async () => {
    const { code, out } = await run("guarded");
    assert.equal(code, 0, out);
    // Every refusal ran: the window was really exercised, not slept past.
    assert.match(out, /ALIVE refused=25\b/, out);
  });

  it("node-ws's socket.end() on a refused upgrade hitting EPIPE is handled (OrgChart's exact crash)", async () => {
    // A stand-in for node-ws's listener: await (the guard/auth/route), then
    // end() the raw socket. The socket's write fails with EPIPE, as it does
    // when the peer is gone. Unguarded, that 'error' has no listener and is
    // thrown as an uncaught exception.
    const server = new EventEmitter();
    let ended = false;
    const inject = (s: EventEmitter) => {
      s.on("upgrade", async (_req: unknown, socket: Duplex) => {
        await new Promise((r) => setImmediate(r));
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        ended = true;
      });
    };
    attachWebSockets(server as never, inject, "test");
    const socket = new Duplex({
      read() {},
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      server.emit("upgrade", {}, socket, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    assert.ok(ended, "the refusal ran");
    assert.deepEqual(uncaught, [], "the EPIPE was handled, not thrown");
  });

  /** A real server: Hono + node-ws through attachWebSockets, with one
   *  accepting WebSocket route that echoes. */
  async function realServer() {
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.get(
      "/ws/echo",
      upgradeWebSocket(() => ({
        onMessage(ev, ws) {
          ws.send(`echo:${ev.data}`);
        },
      })),
    );
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    attachWebSockets(server, injectWebSocket, "test");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    return { server, port };
  }

  it("a real WebSocket through attachWebSockets still opens and works (the guard doesn't break upgrades)", async () => {
    const { server, port } = await realServer();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/echo`);
      await once(ws, "open");
      ws.send("hi");
      const [msg] = (await once(ws, "message")) as [MessageEvent];
      assert.equal(msg.data, "echo:hi");
      ws.close();
    } finally {
      server.close();
    }
  });

  it("an upgrade whose URL node-ws can't parse is CLOSED, not leaked, and nothing is left unhandled", async () => {
    // Node's parser accepts `GET //[`, but node-ws's `new URL` throws before
    // it answers: unwrapped, an unhandled rejection plus a socket that is
    // never answered or closed.
    const { server, port } = await realServer();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => {});
      await once(s, "connect");
      s.write(
        "GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n" +
          "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      const closed = await Promise.race([
        once(s, "close").then(() => true),
        new Promise((r) => setTimeout(() => r(false), 3000)),
      ]);
      assert.equal(closed, true, "the server closed the socket");
      assert.deepEqual(rejections, [], "no unhandled rejection");
    } finally {
      process.off("unhandledRejection", onRejection);
      server.close();
    }
  });

  it("run.ts gives every listener WebSockets through attachWebSockets (no bare injectWebSocket)", () => {
    const src = readFileSync(join(HERE, "..", "run.ts"), "utf8");
    // node-ws's inject functions may only ever be passed to attachWebSockets.
    const bare = src.match(/\b(?:injectWebSocket|iInject)\(/g) ?? [];
    assert.deepEqual(bare, [], "a listener bypasses the upgrade-socket guard");
    assert.equal(
      (src.match(/attachWebSockets\(/g) ?? []).length,
      3,
      "public, --host extras, internal",
    );
  });
});
