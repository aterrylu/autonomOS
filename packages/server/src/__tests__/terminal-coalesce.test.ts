import assert from "node:assert";
import { test } from "node:test";
import { makeStreamForwarder } from "../routes/terminal.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWs() {
  const sent: string[] = [];
  return { sent, send: (d: string) => sent.push(d) };
}

const ON = { coalesce: true, windowMs: 8, maxBytes: 16384 };

test("coalesce OFF — one send per chunk, byte-identical passthrough", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...ON, coalesce: false });
  for (const c of ["a", "bb", "ccc"]) f.onData(c);
  assert.deepEqual(ws.sent, ["a", "bb", "ccc"]);
});

test("leading edge — first chunk after idle flushes immediately (0 added latency)", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, ON);
  f.onData("x"); // stream idle → sent now, no waiting for the window
  assert.deepEqual(ws.sent, ["x"]);
});

test("burst — leading chunk immediate, rapid remainder coalesced into one frame", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...ON, windowMs: 50 });
  f.onData("a"); // leading → flushed
  f.onData("b");
  f.onData("c");
  f.onData("d"); // within the 50ms window → pending
  assert.deepEqual(ws.sent, ["a"], "only the leading chunk so far");
  await sleep(120); // >> 50ms window, generous margin for a loaded CI box
  assert.deepEqual(ws.sent, ["a", "bcd"], "remainder coalesced");
});

test("size threshold forces a flush mid-burst (no waiting for the window)", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: true,
    windowMs: 1000,
    maxBytes: 4,
  });
  f.onData("ab"); // leading → flushed
  f.onData("cd"); // pending (2 < 4)
  assert.deepEqual(ws.sent, ["ab"]);
  f.onData("ef"); // pending now 4 ≥ maxBytes → flush
  assert.deepEqual(ws.sent, ["ab", "cdef"]);
});

test("close() flushes pending bytes", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, { ...ON, windowMs: 1000 });
  f.onData("a"); // leading → flushed
  f.onData("tail"); // pending (within window)
  assert.deepEqual(ws.sent, ["a"]);
  f.close();
  assert.deepEqual(ws.sent, ["a", "tail"]);
});

test("slow trickle — each chunk after an idle gap flushes immediately", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, ON); // 8ms window
  f.onData("line1\n");
  await sleep(20); // idle gap > window
  f.onData("line2\n");
  await sleep(20);
  f.onData("line3\n");
  // A slow stream never coalesces — every line is its own immediate frame.
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
  f.onData("prime"); // leading → flush → ok
  assert.deepEqual(sent, ["prime"]);
  fail = true; // socket dies
  f.onData("x");
  f.onData("y"); // within window → pending, timer armed
  await sleep(25); // timer fires → flush → send throws → onSendError
  assert.equal(errors, 1, "onSendError fired once for the dropped frame");
  assert.deepEqual(sent, ["prime"], "no further successful sends");
});
