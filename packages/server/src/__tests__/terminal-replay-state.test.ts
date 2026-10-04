/**
 * A reconnect replay must rebuild the terminal STATE, not just re-send bytes.
 *
 * Terry's two bugs (Codex pane frozen / unscrollable; Claude no_flicker pane
 * black except the regions that repaint) both came from the replay: a raw,
 * front-trimmed byte log that had lost the modes the TUI set once at startup,
 * delivered to a pane at the wrong size. These tests drive the real route over
 * real sockets with REAL captured Codex / Claude streams.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

// Config-dir isolation (test-escape guard).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-replay-"));

const {
  terminalRouter,
  _resetTerminalFenceForTesting,
  REPLAY_END_MARK,
  REPAINT_NUDGE_RESTORE_MS,
  nudgeRepaint,
} = await import("../routes/terminal.js");
const { _registerSyntheticAttachment, _unregisterSyntheticAttachment } =
  await import("../agents/runtime.js");
const { DecModeTracker } = await import("../agents/terminalModes.js");
const { FakePty } = await import("../perf/fake-pty.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type UUID = `${string}-${string}-${string}-${string}-${string}`;

const fixture = (name: string): string[] =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/tui-stream-${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const CODEX = fixture("codex");
const CLAUDE = fixture("claude");
const MB = 1024 * 1024;

let port = 0;
let server: ReturnType<typeof serve>;
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
  (server as unknown as Server).closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const opened: WebSocket[] = [];
const registered: string[] = [];
beforeEach(() => _resetTerminalFenceForTesting());
afterEach(async () => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  for (const id of registered.splice(0))
    _unregisterSyntheticAttachment(id as UUID);
  await sleep(20);
});

let n = 0;
function session(chunks: string[]) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const pty = new FakePty();
  const resizes: [number, number][] = [];
  const realResize = pty.resize;
  pty.resize = (c: number, r: number) => {
    resizes.push([c, r]);
    realResize(c, r);
  };
  _registerSyntheticAttachment(id as UUID, pty.asIPty());
  registered.push(id);
  pty.emitBurst(chunks);
  return { id, pty, resizes };
}

/** A real stream, then its body repeated past the 1MB cap so the buffer has
 *  lost its start (exactly what a long-running session looks like). */
function pastTheCap(stream: string[]): string[] {
  const body = stream.slice(Math.floor(stream.length / 3));
  const out = [...stream];
  let size = out.reduce((a, c) => a + c.length, 0);
  while (size < 1.3 * MB) {
    for (const c of body) {
      out.push(c);
      size += c.length;
    }
  }
  return out;
}

/** Open, collect every text frame until the end-of-replay marker. */
async function replayOf(id: string, query = "?replayMark=1") {
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}${query}`);
  opened.push(ws);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no end marker")), 5000);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      frames.push(ev.data);
      if (ev.data.includes("autonomos-replay-end")) {
        clearTimeout(t);
        resolve();
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  return frames;
}

describe("replay restores the sticky modes a trimmed buffer lost", () => {
  for (const [name, stream] of [
    ["codex", CODEX],
    ["claude", CLAUDE],
  ] as const) {
    it(`${name}: a replay of a >1MB session ends in the LIVE mode state`, async () => {
      const chunks = pastTheCap(stream);
      const { id } = session(chunks);
      const live = new DecModeTracker();
      for (const c of chunks) live.feed(c);

      const replay = (await replayOf(id)).join("");
      // Sanity: the buffer really lost the bytes that set the modes.
      assert.ok(
        replay.length < chunks.reduce((a, c) => a + c.length, 0),
        "trimmed",
      );
      const viewer = new DecModeTracker(); // what a reset pane ends up in
      viewer.feed(replay);
      assert.equal(viewer.inAltScreen(), live.inAltScreen());
      for (const m of [1007, 1000, 1002, 1003, 1006, 2004, 25]) {
        assert.equal(viewer.isOn(m), live.isOn(m), `mode ${m}`);
      }
    });
  }

  it("codex: the wheel mode (?1007h) is in the replay BEFORE any retained byte", async () => {
    const { id } = session(pastTheCap(CODEX));
    const replay = (await replayOf(id)).join("");
    assert.ok(replay.startsWith("\x1b[?1049h"), "alt screen first");
    assert.ok(replay.indexOf("\x1b[?1007h") < 64, "alternate scroll restored");
  });

  it("a short session (nothing trimmed) replays byte-for-byte, no preamble", async () => {
    const { id } = session(CODEX);
    const replay = (await replayOf(id)).join("");
    assert.equal(replay, CODEX.join("") + REPLAY_END_MARK);
  });
});

describe("geometry before the replay (?replayGeom=1)", () => {
  it("the FIRST frame carries the PTY size, before any replayed byte", async () => {
    const { id, pty } = session(CLAUDE);
    pty.resize(203, 61);
    const frames = await replayOf(id, "?replayMark=1&replayGeom=1");
    assert.equal(
      frames[0],
      "\x1b]7777;autonomos-replay-begin;cols=203;rows=61\x07",
    );
  });

  it("is opt-in: an older dashboard never receives it", async () => {
    const { id } = session(CLAUDE);
    const replay = (await replayOf(id)).join("");
    assert.equal(replay.includes("autonomos-replay-begin"), false);
  });
});

describe("repaint nudge after a trimmed alternate-screen replay", () => {
  it("a trimmed session on the alt screen gets a REAL size change and back", async () => {
    const { id, pty, resizes } = session(pastTheCap(CODEX));
    pty.resize(150, 50);
    resizes.length = 0;
    await replayOf(id);
    assert.deepEqual(resizes, [[150, 49]], "real change → SIGWINCH");
    await sleep(REPAINT_NUDGE_RESTORE_MS + 40);
    assert.deepEqual(resizes, [
      [150, 49],
      [150, 50],
    ]);
  });

  it("no nudge when nothing was trimmed (the replay already holds the paint)", async () => {
    const { id, resizes } = session(CODEX);
    resizes.length = 0;
    await replayOf(id);
    await sleep(REPAINT_NUDGE_RESTORE_MS + 40);
    assert.deepEqual(resizes, []);
  });

  it("no nudge for a trimmed session that is NOT on the alternate screen", async () => {
    const plain = ["plain output line\r\n".repeat(2000)];
    const { id, resizes } = session(Array.from({ length: 40 }, () => plain[0]));
    resizes.length = 0;
    await replayOf(id);
    await sleep(REPAINT_NUDGE_RESTORE_MS + 40);
    assert.deepEqual(resizes, []);
  });

  it("rate-limited per PTY; a client resize in between wins over the restore", () => {
    const pty = new FakePty();
    pty.resize(100, 30);
    assert.equal(nudgeRepaint(pty.asIPty(), 10_000), true);
    assert.equal(nudgeRepaint(pty.asIPty(), 10_500), false, "within 2s");
    pty.resize(120, 40); // the client fitted meanwhile
    return sleep(REPAINT_NUDGE_RESTORE_MS + 40).then(() => {
      assert.deepEqual([pty.cols, pty.rows], [120, 40], "not clobbered");
    });
  });
});
