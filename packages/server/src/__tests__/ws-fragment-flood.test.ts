import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import WebSocket from "ws";

/**
 * Security audit V12b: ws < 8.21.1 let a peer send one message as an unbounded
 * number of tiny fragments. Each one is kept until the message ends, so a
 * modest stream of 6-byte frames grows the server's heap without limit and
 * OOMs the whole process (every agent's terminal goes with it). maxPayload
 * doesn't help: it counts payload bytes, and an empty fragment has none.
 * 8.21.0 added a fragment limit but didn't count EMPTY fragments; 8.21.1 does.
 *
 * Every WebSocket the server accepts (terminal, agents, gateway) comes from
 * @hono/node-ws's createNodeWebSocket, which builds ws's WebSocketServer with
 * no options, so ws's DEFAULT limits are the only ones in force. This guard
 * builds the server exactly that way and pins the behavior:
 *  - one message split into 20,000 empty fragments (over the 16,384 default)
 *    is refused with 1008, so the flood can't grow without bound;
 *  - normal traffic is untouched: a browser sends each message as ONE frame,
 *    so a 1 MiB paste and a fast burst of single keystrokes both arrive.
 */

let server: Server;
let url: string;
// Every socket on both ends, so teardown can't hang on one a RED run left
// open (an upgraded socket keeps server.close() waiting forever).
const clients: WebSocket[] = [];
let serverSockets: Set<{ terminate(): void }>;
const received: number[] = [];

before(async () => {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({
    app,
  });
  serverSockets = wss.clients;
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onMessage(evt) {
        const d = evt.data;
        received.push(
          typeof d === "string" ? d.length : (d as ArrayBuffer).byteLength,
        );
      },
    })),
  );
  server = createAdaptorServer({ fetch: app.fetch }) as Server;
  injectWebSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

after(() => {
  for (const c of clients) c.terminate();
  for (const s of serverSockets) s.terminate();
  server.closeAllConnections?.();
  server.close();
});

function open(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    clients.push(ws);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

/** Resolve with the close code, or null if still open after `ms`. */
function closeCode(ws: WebSocket, ms: number): Promise<number | null> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    ws.once("close", (code) => {
      clearTimeout(t);
      res(code);
    });
  });
}

describe("ws refuses a fragment flood on the server's sockets (audit V12b)", () => {
  it("one message as 20,000 empty fragments is closed with 1008", async () => {
    const sock = await open();
    sock.on("error", () => {});
    const closed = closeCode(sock, 5_000);
    const empty = Buffer.alloc(0);
    for (let i = 0; i < 20_000 && sock.readyState === WebSocket.OPEN; i++) {
      sock.send(empty, { fin: false, binary: true });
    }
    assert.equal(
      await closed,
      1008,
      "the server kept buffering fragments of one unfinished message: the ws " +
        "that @hono/node-ws loads is < 8.21.1. If bun.lock is right, this tree " +
        "kept a stale nested copy: run `bun install --force --frozen-lockfile`.",
    );
  });

  it("a 1 MiB paste and a 2,000-keystroke burst still arrive intact", async () => {
    received.length = 0;
    const sock = await open();
    const closed = closeCode(sock, 1_500);
    sock.send(Buffer.alloc(1024 * 1024, 0x61));
    sock.send("x".repeat(1024 * 1024));
    for (let i = 0; i < 2_000; i++) sock.send("k");
    assert.equal(await closed, null, "normal traffic closed the socket");
    sock.close();
    assert.equal(received.length, 2_002, "every message was delivered");
    assert.equal(received[0], 1024 * 1024);
    assert.equal(received[1], 1024 * 1024);
  });
});
