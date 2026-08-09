import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createRotatingWriter,
  createTimestampingWriter,
  type RotatingWriter,
} from "../logger.js";

// Isolated temp dir per run — no fs writes at import time (see CLAUDE.md / the
// Linux e2e CI constraint), all writes happen inside the tests.
let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `autonomos-logger-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createRotatingWriter", () => {
  it("writes to a single segment when under maxBytes", () => {
    const file = join(dir, "autonomos.log");
    const w = createRotatingWriter(file, 1024, 3);
    w.write("hello\n");
    w.write("world\n");
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, "utf-8"), "hello\nworld\n");
    assert.ok(!existsSync(`${file}.1`), "should not rotate under the cap");
  });

  it("rotates when a write would exceed maxBytes", () => {
    const file = join(dir, "autonomos.log");
    const chunk = "x".repeat(60); // 60 bytes
    const w = createRotatingWriter(file, 100, 3);

    w.write(chunk); // 60 — fits
    assert.ok(!existsSync(`${file}.1`));
    w.write(chunk); // 60+60 > 100 → rotate, then write into fresh segment
    assert.ok(existsSync(`${file}.1`), "rotated segment .1 should exist");
    assert.equal(readFileSync(`${file}.1`, "utf-8").length, 60);
    assert.equal(readFileSync(file, "utf-8").length, 60);
  });

  it("keeps only `keep` rotated backups, dropping the oldest", () => {
    const file = join(dir, "autonomos.log");
    const chunk = "y".repeat(60);
    const w = createRotatingWriter(file, 100, 2); // keep 2 backups: .1 and .2

    // Each write past the first forces a rotation.
    for (let i = 0; i < 5; i++) w.write(chunk);

    assert.ok(existsSync(file), "active segment exists");
    assert.ok(existsSync(`${file}.1`), ".1 exists");
    assert.ok(existsSync(`${file}.2`), ".2 exists");
    assert.ok(
      !existsSync(`${file}.3`),
      ".3 must not exist — oldest is dropped at keep=2",
    );
  });

  it("never throws on a write after the directory is removed", () => {
    const file = join(dir, "nested", "autonomos.log");
    const w = createRotatingWriter(file, 1024, 2);
    w.write("before\n");
    rmSync(dir, { recursive: true, force: true });
    // Underlying stream errors are swallowed — must not throw into the caller.
    assert.doesNotThrow(() => w.write("after\n"));
  });
});

describe("createTimestampingWriter", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

  function makeSink(): { writer: RotatingWriter; chunks: string[] } {
    const chunks: string[] = [];
    return {
      chunks,
      writer: {
        path: "/dev/null",
        write(chunk) {
          chunks.push(
            typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString("utf-8"),
          );
        },
      },
    };
  }

  it("prefixes every line with an ISO timestamp", () => {
    const sink = makeSink();
    const w = createTimestampingWriter(sink.writer);
    w.write("[scheduler] started\n[gateway] agent connected\n");
    const lines = sink.chunks.join("").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, ISO);
  });

  it("does not re-stamp a line continued across chunks", () => {
    const sink = makeSink();
    const w = createTimestampingWriter(sink.writer);
    w.write("partial");
    w.write(" line\n");
    const text = sink.chunks.join("");
    assert.match(text, ISO);
    assert.match(text, /partial line\n$/);
    const stamps = text.match(/\d{4}-\d{2}-\d{2}T/g) ?? [];
    assert.equal(stamps.length, 1, "one stamp for one line");
  });

  it("stamps each line of a multi-line chunk (error stacks stay greppable)", () => {
    const sink = makeSink();
    const w = createTimestampingWriter(sink.writer);
    w.write("Error: boom\n    at somewhere\n    at elsewhere\n");
    const lines = sink.chunks.join("").split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.match(line, ISO);
  });

  it("uses the injected clock", () => {
    const sink = makeSink();
    const fixed = new Date("2026-08-08T12:00:00.000Z");
    const w = createTimestampingWriter(sink.writer, () => fixed);
    w.write("hello\n");
    assert.equal(sink.chunks.join(""), "2026-08-08T12:00:00.000Z hello\n");
  });

  it("empty writes are a no-op", () => {
    const sink = makeSink();
    const w = createTimestampingWriter(sink.writer);
    w.write("");
    assert.equal(sink.chunks.length, 0);
  });
});
