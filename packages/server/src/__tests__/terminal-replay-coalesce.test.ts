import assert from "node:assert";
import { test } from "node:test";
import { buildReplayFrames } from "../routes/terminal.js";

const ON = { coalesce: true, maxBytes: 10 };

test("coalesce OFF — one frame per chunk, byte-identical passthrough", () => {
  const chunks = ["a", "bb", "ccc"];
  assert.deepEqual(
    buildReplayFrames(chunks, { ...ON, coalesce: false }),
    chunks,
  );
});

test("packs chunks until maxBytes, preserving order and every byte", () => {
  const chunks = ["aaaa", "bbbb", "cc", "dd", "e"];
  const frames = buildReplayFrames(chunks, ON);
  // 4+4+2 = 10 ≥ maxBytes closes frame 1; "dd" + "e" become the tail frame.
  assert.deepEqual(frames, ["aaaabbbbcc", "dde"]);
  assert.equal(frames.join(""), chunks.join(""), "byte-identical");
});

test("tail below maxBytes still ships as a final frame", () => {
  const frames = buildReplayFrames(["aaaa"], ON);
  assert.deepEqual(frames, ["aaaa"]);
});

test("a single oversized chunk goes out unsplit (never truncated)", () => {
  const big = "x".repeat(100);
  const frames = buildReplayFrames([big, "tail"], ON);
  assert.deepEqual(frames, [big, "tail"]);
});

test("empty buffer → no frames (a fresh session replays nothing)", () => {
  assert.deepEqual(buildReplayFrames([], ON), []);
});

test("realistic shape — many tiny chunks collapse ~maxBytes-fold", () => {
  const chunks = Array.from({ length: 10_000 }, (_, i) => `c${i % 10}`);
  const frames = buildReplayFrames(chunks, {
    coalesce: true,
    maxBytes: 64 * 1024,
  });
  assert.equal(frames.join(""), chunks.join(""), "byte-identical");
  assert.ok(
    frames.length <= Math.ceil(chunks.join("").length / (64 * 1024)) + 1,
    `expected ~1 frame per 64KB, got ${frames.length}`,
  );
});
