import assert from "node:assert";
import { test } from "node:test";
import { makeStreamForwarder } from "../routes/terminal.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWs() {
  const sent: string[] = [];
  return { sent, send: (d: string) => sent.push(d) };
}

test("coalesce OFF — one send per chunk, byte-identical passthrough", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: false,
    windowMs: 8,
    maxBytes: 16384,
  });
  for (const c of ["a", "bb", "ccc"]) f.onData(c);
  assert.deepEqual(ws.sent, ["a", "bb", "ccc"]);
});

test("coalesce ON — small chunks batch into a single timed flush", async () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: true,
    windowMs: 8,
    maxBytes: 16384,
  });
  for (const c of ["a", "b", "c", "d"]) f.onData(c);
  // Nothing sent synchronously — still inside the window.
  assert.equal(ws.sent.length, 0);
  await sleep(20);
  assert.deepEqual(ws.sent, ["abcd"]);
});

test("coalesce ON — size threshold forces an immediate flush", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: true,
    windowMs: 1000,
    maxBytes: 4,
  });
  f.onData("ab");
  assert.equal(ws.sent.length, 0); // under threshold
  f.onData("cd"); // now 4 bytes >= maxBytes → flush now, no waiting for window
  assert.deepEqual(ws.sent, ["abcd"]);
});

test("coalesce ON — close() flushes pending bytes", () => {
  const ws = fakeWs();
  const f = makeStreamForwarder(ws, () => {}, {
    coalesce: true,
    windowMs: 1000,
    maxBytes: 16384,
  });
  f.onData("tail");
  assert.equal(ws.sent.length, 0);
  f.close();
  assert.deepEqual(ws.sent, ["tail"]);
});

test("coalesce ON — total bytes preserved across a fragmented burst", async () => {
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
  assert.equal(ws.sent.join(""), expected); // no byte lost or reordered
  assert.ok(ws.sent.length < chunks.length, "frames were actually coalesced");
});
