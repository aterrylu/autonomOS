import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRotatingWriter } from "../logger.js";

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
