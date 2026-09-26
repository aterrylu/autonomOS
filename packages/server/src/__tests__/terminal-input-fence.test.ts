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
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

// Config-dir isolation (test-escape guard).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-fence-"));

const {
  terminalRouter,
  _resetTerminalFenceForTesting,
  _startLivenessPingForTesting,
  TERMINAL_PING_MS,
  TERMINAL_DEAD_AFTER_MS,
  REPLAY_END_MARK,
  REPLAY_END_MARK_ACK,
  INPUT_MAX_AGE_MS,
} = await import("../routes/terminal.js");
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

async function open(
  sessionId: string,
  query = "",
  onMessage?: (d: string) => void,
): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/terminal/${sessionId}${query}`,
  );
  opened.push(ws);
  if (onMessage) {
    ws.addEventListener("message", (ev) =>
      onMessage(typeof ev.data === "string" ? ev.data : ""),
    );
  }
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

describe("fence ordering + input stamping", () => {
  it("a resize on a superseded socket is ignored too (stale dimensions)", async () => {
    const id = "00000000-0000-4000-8000-0000000fe006";
    const { pty } = session(id);
    const g1 = await open(id, `?client=${CLIENT}&gen=1`);
    const g2 = await open(id, `?client=${CLIENT}&gen=2`);
    g2.send(JSON.stringify({ type: "resize", cols: 150, rows: 40 }));
    await settle();
    g1.send(JSON.stringify({ type: "resize", cols: 60, rows: 20 }));
    await settle();
    assert.equal(pty.cols, 150, "the superseded socket's resize must not win");
  });

  it("a PTY write that throws does not stamp input as received", async () => {
    const id = "00000000-0000-4000-8000-0000000fe007";
    const { pty } = session(id);
    pty.write = () => {
      throw new Error("EIO: pty closed");
    };
    const ws = await open(id, `?client=${CLIENT}&gen=1`);
    ws.send("k");
    await settle();
    const io = (await (await agentsRouter.request(`/${id}/io`)).json()) as {
      inputAgeMs: number | null;
    };
    assert.equal(io.inputAgeMs, null);
  });
});

describe("end-of-replay marker", () => {
  it("is sent right after the replay, only to clients that ask (?replayMark=1)", async () => {
    const id = "00000000-0000-4000-8000-0000000fe020";
    const { pty } = session(id);
    pty.emit("SCROLLBACK");
    const got: string[] = [];
    await open(id, `?client=${CLIENT}&gen=1&replayMark=1`, (d) => got.push(d));
    await settle();
    assert.ok(got.join("").includes("SCROLLBACK"), "replay arrived");
    assert.equal(got.at(-1), REPLAY_END_MARK, "marker follows the replay");
    assert.ok(
      got.join("").indexOf("SCROLLBACK") <
        got.join("").indexOf(REPLAY_END_MARK),
    );

    const plain: string[] = [];
    await open(id, "", (d) => plain.push(d)); // an older dashboard
    await settle();
    assert.ok(!plain.join("").includes(REPLAY_END_MARK), "never unsolicited");
  });

  it("uses an OSC form a terminal that doesn't know it will ignore", () => {
    assert.match(REPLAY_END_MARK, /^\x1b\]7777;[^\x07]*\x07$/);
  });
});

describe("server-side liveness ping", () => {
  function fakeRaw() {
    const r = {
      pings: 0,
      terminated: false,
      pongCb: null as null | (() => void),
      ping() {
        r.pings++;
      },
      terminate() {
        r.terminated = true;
      },
      on(_e: "pong", cb: () => void) {
        r.pongCb = cb;
      },
    };
    return r;
  }

  // VIRTUAL TIME. These ran on real 20ms/70ms timers and flaked under the
  // parallel pre-push gate (load ~30): a slipped timer missed the post-stall
  // window. The pinger reads only Date.now() and setInterval, so mock.timers
  // drives it exactly — and at the PRODUCTION timings.
  //
  // Measured mock.timers behavior (node 25) the helpers rely on: a single
  // tick() runs every due interval callback with Date.now() already at the
  // END of the tick, and setTime() moves Date without running timers. So:
  // step() advances ONE ping period per tick (each firing sees a realistic
  // clock), and setTime() followed by one tick is a stalled event loop — the
  // first late firing sees the whole gap, its catch-up duplicates see none.
  const P = TERMINAL_PING_MS;
  const D = TERMINAL_DEAD_AFTER_MS;
  const OPTS = { pingMs: P, deadAfterMs: D };
  const step = (ms: number) => {
    for (let t = 0; t < ms; t += P) mock.timers.tick(P);
  };
  beforeEach(() => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("terminates a socket that stops answering pings (half-open) on the first tick past the deadline", () => {
    const raw = fakeRaw();
    const stop = _startLivenessPingForTesting(raw, OPTS);
    step(D);
    assert.equal(
      raw.terminated,
      false,
      "silent for exactly the deadline: kept",
    );
    assert.equal(raw.pings, D / P, "pinging every period meanwhile");
    step(P);
    assert.equal(raw.terminated, true, "no pong past the deadline → dead");
    stop?.();
  });

  it("keeps a socket that answers", () => {
    const raw = fakeRaw();
    const stop = _startLivenessPingForTesting(raw, OPTS);
    for (let i = 0; i < 30; i++) {
      step(P);
      raw.pongCb?.();
    }
    assert.equal(raw.terminated, false);
    assert.equal(raw.pings, 30);
    stop?.();
  });

  it("after OUR OWN event loop stalled, grants a fresh deadline instead of killing at once — then still kills a link that stays silent", () => {
    const raw = fakeRaw();
    const stop = _startLivenessPingForTesting(raw, OPTS);
    raw.pongCb?.();
    step(P);
    // The server process stalls (a SIGSTOP / long sync task) far past the
    // deadline: the clock moves, no timer runs. No pongs arrive afterwards
    // either, so only the grace can save the socket on the first tick after.
    mock.timers.setTime(Date.now() + 10 * D);
    step(P);
    assert.equal(
      raw.terminated,
      false,
      "missing pongs during OUR stall are our fault — no instant kill",
    );
    // The grace restarted the deadline AT that tick; as in the plain case,
    // silence of exactly D is kept and the next tick kills.
    step(D);
    assert.equal(raw.terminated, false, "still inside the fresh deadline");
    step(P);
    assert.equal(raw.terminated, true, "a genuinely dead link still dies");
    stop?.();
  });

  it("ignores a context without a raw ws (defensive: no crash, no pinger)", () => {
    assert.equal(
      _startLivenessPingForTesting(undefined, { pingMs: 20, deadAfterMs: 70 }),
      undefined,
    );
  });
});

describe("acked input (binary control plane)", () => {
  function inputFrame(seq: number, sentAtMs: number, text: string) {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(9 + body.length);
    out[0] = 0x01;
    const v = new DataView(out.buffer);
    v.setUint32(1, seq);
    v.setUint32(5, sentAtMs);
    out.set(body, 9);
    return out;
  }
  async function openAck(id: string, q = "") {
    const acks: number[] = [];
    const texts: string[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal/${id}?client=${CLIENT}&gen=1&replayMark=1&inputAck=1${q}`,
    );
    ws.binaryType = "arraybuffer";
    opened.push(ws);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") texts.push(ev.data);
      else acks.push(new DataView(ev.data as ArrayBuffer).getUint32(1));
    });
    await new Promise<void>((r) =>
      ws.addEventListener("open", () => r(), { once: true }),
    );
    return { ws, acks, texts };
  }

  it("advertises input-ack in the replay marker only to a client that asked", async () => {
    const id = "00000000-0000-4000-8000-0000000fe030";
    session(id);
    const { texts } = await openAck(id);
    await settle();
    assert.ok(texts.join("").includes(REPLAY_END_MARK_ACK));
    const plain: string[] = [];
    await open(id, `?client=other-tab-3333&gen=1&replayMark=1`, (d) =>
      plain.push(d),
    );
    await settle();
    assert.ok(plain.join("").includes(REPLAY_END_MARK));
    assert.ok(!plain.join("").includes("input-ack"));
  });

  it("writes an acked frame's keystrokes and acks its seq AFTER the write", async () => {
    const id = "00000000-0000-4000-8000-0000000fe031";
    const { writes } = session(id);
    const { ws, acks } = await openAck(id);
    await settle();
    ws.send(inputFrame(7, 50, "hi"));
    await settle();
    assert.deepEqual(writes, ["hi"]);
    assert.deepEqual(acks, [7]);
  });

  it("never writes (or acks) a frame older than the client's give-up — no late keys after a stall", async () => {
    const id = "00000000-0000-4000-8000-0000000fe032";
    const { writes } = session(id);
    const { ws, acks } = await openAck(id);
    await sleep(INPUT_MAX_AGE_MS + 200);
    // sentAtMs = 0 → the key was typed right at open, now > 2.5s ago.
    ws.send(inputFrame(1, 0, "STALE"));
    await settle();
    assert.deepEqual(writes, []);
    assert.deepEqual(acks, []);
  });

  it("does not ack a write that failed", async () => {
    const id = "00000000-0000-4000-8000-0000000fe033";
    const { pty } = session(id);
    pty.write = () => {
      throw new Error("EIO: pty closed");
    };
    const { ws, acks } = await openAck(id);
    await settle();
    ws.send(inputFrame(3, 10, "k"));
    await settle();
    assert.deepEqual(acks, []);
  });

  it("on a NEGOTIATED socket a malformed binary frame is dropped, never typed into the agent", async () => {
    // Found live: a harness sending an older frame layout had its header
    // bytes written into the agent's prompt as text.
    const id = "00000000-0000-4000-8000-0000000fe035";
    const { writes } = session(id);
    const { ws, acks } = await openAck(id);
    await settle();
    const short = new Uint8Array([0x01, 0, 0, 0, 9, 0x78]); // old 5-byte header
    ws.send(short);
    ws.send(new Uint8Array([0x7f, 1, 2, 3, 4, 5, 6, 7, 8, 9])); // unknown type
    await settle();
    assert.deepEqual(writes, []);
    assert.deepEqual(acks, []);
  });

  it("a socket that did NOT negotiate treats binary as text (the old behavior)", async () => {
    const id = "00000000-0000-4000-8000-0000000fe034";
    const { writes } = session(id);
    const ws = await open(id, `?client=${CLIENT}&gen=1`);
    ws.send(new TextEncoder().encode("raw"));
    await settle();
    assert.deepEqual(writes, ["raw"]);
  });
});
