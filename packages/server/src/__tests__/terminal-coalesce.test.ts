import assert from "node:assert";
import { test } from "node:test";
import { makeStreamForwarder } from "../routes/terminal.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWs() {
  const sent: string[] = [];
  return { sent, send: (d: string) => sent.push(d) };
}

const ON = { coalesce: true, windowMs: 8, maxBytes: 16384 };
const LEADING = { ...ON, leadingEdge: true };

test("coalesce OFF — one send per chunk, byte-identical passthrough", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...ON, coalesce: false });
  for (const c of ["a", "bb", "ccc"]) f.onData(c);
  assert.deepEqual(ws.sent, ["a", "bb", "ccc"]);
});

test("trailing edge (default) — an after-idle chunk WAITS for the window, so a multi-chunk repaint ships whole", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...ON, windowMs: 30 });
  f.onData("\x1b[2A\x1b[2K"); // repaint's ERASE half — must NOT go out alone
  f.onData("redrawn line");
  assert.deepEqual(ws.sent, [], "nothing flushed before the window");
  await sleep(100);
  assert.deepEqual(
    ws.sent,
    ["\x1b[2A\x1b[2Kredrawn line"],
    "erase+redraw in ONE frame",
  );
});

test("leading edge (ablation flag) — first chunk after idle flushes immediately", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...LEADING, windowMs: 50 });
  f.onData("a"); // leading → flushed
  f.onData("b");
  f.onData("c");
  assert.deepEqual(ws.sent, ["a"], "only the leading chunk so far");
  await sleep(120);
  assert.deepEqual(ws.sent, ["a", "bc"], "remainder coalesced");
});

test("size threshold forces a flush mid-burst (no waiting for the window)", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: true,
    windowMs: 1000,
    maxBytes: 4,
  });
  f.onData("ab"); // pending (2 < 4) — trailing edge, nothing flushes yet
  assert.deepEqual(ws.sent, []);
  f.onData("cd"); // pending now 4 ≥ maxBytes → flush
  assert.deepEqual(ws.sent, ["abcd"]);
});

test("close() flushes pending bytes", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...ON, windowMs: 1000 });
  f.onData("a");
  f.onData("tail"); // both pending (trailing edge, within window)
  assert.deepEqual(ws.sent, []);
  f.close();
  assert.deepEqual(ws.sent, ["atail"]);
});

test("slow trickle — each chunk still ships as its own frame (one window later)", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, ON); // 8ms window
  f.onData("line1\n");
  await sleep(20); // idle gap > window → timer fired, frame shipped
  f.onData("line2\n");
  await sleep(20);
  f.onData("line3\n");
  await sleep(20);
  // A slow stream never coalesces — each line is its own frame, ≤ window late.
  assert.deepEqual(ws.sent, ["line1\n", "line2\n", "line3\n"]);
});

test("coalesce ON — total bytes preserved + frames reduced across a fragmented burst", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: true,
    windowMs: 4,
    maxBytes: 64,
  });
  const chunks = Array.from({ length: 500 }, (_, i) => `x${i}|`);
  const expected = chunks.join("");
  for (const c of chunks) f.onData(c);
  await sleep(30);
  f.close();
  assert.equal(ws.sent.join(""), expected, "no byte lost or reordered");
  assert.ok(ws.sent.length < chunks.length, "frames were coalesced");
});

test("send failure with pending bytes — frame dropped, onSendError fires once, no crash", async () => {
  // Coalescing-by-default newly exercises flush()'s send-failure path in
  // production (on a dead/half-open socket mid-burst). Verify it fires
  // onSendError exactly once and doesn't keep trying.
  let fail = false;
  let errors = 0;
  const sent: string[] = [];
  const ws = {
    send: (d: string) => {
      if (fail) throw new Error("dead socket");
      sent.push(d);
    },
  };
  const f = makeStreamForwarder(ws, () => errors++, { ...ON, windowMs: 8 });
  f.onData("prime"); // trailing edge → ships when the window timer fires
  await sleep(25);
  assert.deepEqual(sent, ["prime"]);
  fail = true; // socket dies
  f.onData("x");
  f.onData("y"); // within window → pending, timer armed
  await sleep(25); // timer fires → flush → send throws → onSendError
  assert.equal(errors, 1, "onSendError fired once for the dropped frame");
  assert.deepEqual(sent, ["prime"], "no further successful sends");
});
