// Superseded-socket input fence + the /io recency probe (honest connection
// indicator). Real terminal route + FakePty over real sockets, like the other
// terminal tests.
//
// The fence exists because of a rig measurement: a dashboard pane abandoned a
// half-open terminal socket and reconnected, and the keys already sent on the
// old one ("STRANDED") still reached the agent when the link recovered — a
// silent late burst. Once a NEWER generation from the same client has opened,
// input on an older one must be dropped.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

// Config-dir isolation (test-escape guard).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-fence-"));

const { terminalRouter, _resetTerminalFenceForTesting } = await import(
  "../routes/terminal.js"
);
const { _registerSyntheticAttachment } = await import("../agents/runtime.js");
const { agentsRouter } = await import("../routes/agents.js");
const { FakePty } = await import("../perf/fake-pty.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type UUID = `${string}-${string}-${string}-${string}-${string}`;

let port = 0;
let server: ReturnType<typeof serve>;
const CLIENT = "client-aaaa-1111";

before(async () => {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
  server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as { port: number }).port;
});
after(async () => {
  // close() waits for live connections; the tests below deliberately leave
  // superseded sockets bound, so force them down.
  // serve() is typed as a union incl. Http2Server; this one is HTTP/1.
  (server as unknown as Server).closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const opened: WebSocket[] = [];
beforeEach(() => _resetTerminalFenceForTesting());
afterEach(async () => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  await sleep(20);
});

function session(id: string) {
  const pty = new FakePty();
  const writes: string[] = [];
  pty.write = (d: string) => {
    writes.push(d);
  };
  _registerSyntheticAttachment(id as UUID, pty.asIPty());
  return { pty, writes };
}

async function open(sessionId: string, query = ""): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/terminal/${sessionId}${query}`,
  );
  opened.push(ws);
  await new Promise<void>((r, j) => {
    ws.addEventListener("open", () => r(), { once: true });
    ws.addEventListener("error", () => j(new Error("ws error")), {
      once: true,
    });
  });
  return ws;
}

const settle = () => sleep(40);

describe("terminal input fence", () => {
  it("drops input on an OLDER generation once a newer one from the same client opened — and closes it", async () => {
    const id = "00000000-0000-4000-8000-0000000fe001";
    const { writes } = session(id);
    const g1 = await open(id, `?client=${CLIENT}&gen=1`);
    g1.send("before");
    await settle();
    assert.deepEqual(writes, ["before"], "gen 1 is live until replaced");

    const g2 = await open(id, `?client=${CLIENT}&gen=2`);
    let g1Closed = 0;
    g1.addEventListener("close", (e) => {
      g1Closed = (e as CloseEvent).code;
    });
    // The stranded late burst arriving on the abandoned socket:
    g1.send("STRANDED");
    g2.send("fresh");
    await settle();
    assert.deepEqual(
      writes,
      ["before", "fresh"],
      "late input never reaches the PTY",
    );
    assert.equal(g1Closed, 4011, "the superseded socket is closed");
    g2.close();
  });

  it("never fences a DIFFERENT client (another tab) or an untagged socket", async () => {
    const id = "00000000-0000-4000-8000-0000000fe002";
    const { writes } = session(id);
    const a1 = await open(id, `?client=${CLIENT}&gen=1`);
    const other = await open(id, "?client=other-tab-2222&gen=1");
    const plain = await open(id); // an older dashboard / a script
    await open(id, `?client=${CLIENT}&gen=5`);
    other.send("tab2");
    plain.send("plain");
    a1.send("fenced");
    await settle();
    assert.deepEqual(writes.sort(), ["plain", "tab2"]);
  });

  it("stays fenced after the NEWER socket closes while the older half-open one is still bound", async () => {
    // Retiring the fence when only the newest closes would un-fence the old
    // socket whose late input is still in flight.
    const id = "00000000-0000-4000-8000-0000000fe003";
    const { writes } = session(id);
    const g1 = await open(id, `?client=${CLIENT}&gen=1`);
    const g2 = await open(id, `?client=${CLIENT}&gen=2`);
    g2.close();
    await settle();
    g1.send("STRANDED");
    await settle();
    assert.deepEqual(writes, []);
  });

  it("rejects malformed fence params (treated as untagged, never fenced)", async () => {
    const id = "00000000-0000-4000-8000-0000000fe004";
    const { writes } = session(id);
    const bad = await open(id, "?client=../x&gen=1");
    await open(id, "?client=../x&gen=9");
    bad.send("ok");
    await settle();
    assert.deepEqual(writes, ["ok"]);
  });

  it("resize control messages still work and are not counted as input", async () => {
    const id = "00000000-0000-4000-8000-0000000fe005";
    const { writes, pty } = session(id);
    const ws = await open(id, `?client=${CLIENT}&gen=1`);
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await settle();
    assert.deepEqual(writes, []);
    assert.equal(pty.cols, 100);
  });
});

describe("GET /api/agents/:id/io", () => {
  it("reports input/output AGES (null = never), updated by keystrokes and PTY output", async () => {
    const id = "00000000-0000-4000-8000-0000000fe010";
    const { pty } = session(id);
    let res = await agentsRouter.request(`/${id}/io`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { inputAgeMs: null, outputAgeMs: null });

    const ws = await open(id, `?client=${CLIENT}&gen=1`);
    ws.send("k");
    await settle();
    pty.emit("echo");
    res = await agentsRouter.request(`/${id}/io`);
    const io = (await res.json()) as {
      inputAgeMs: number;
      outputAgeMs: number;
    };
    assert.ok(io.inputAgeMs >= 0 && io.inputAgeMs < 2_000, "input just now");
    assert.ok(io.outputAgeMs >= 0 && io.outputAgeMs < 2_000, "output just now");
    ws.close();
  });

  it("a FENCED (dropped) keystroke does not count as input the server received", async () => {
    // Otherwise the pane watchdog would read "server got your key" for a key
    // that never reached the agent, and blame the agent.
    const id = "00000000-0000-4000-8000-0000000fe011";
    session(id);
    const g1 = await open(id, `?client=${CLIENT}&gen=1`);
    await open(id, `?client=${CLIENT}&gen=2`);
    g1.send("STRANDED");
    await settle();
    const io = (await (await agentsRouter.request(`/${id}/io`)).json()) as {
      inputAgeMs: number | null;
    };
    assert.equal(io.inputAgeMs, null);
  });

  it("404s for an agent with no live PTY", async () => {
    const res = await agentsRouter.request(
      "/00000000-0000-4000-8000-00000000dead/io",
    );
    assert.equal(res.status, 404);
  });
});
