// @vitest-environment node

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { precompressDir } from "../build/precompress";

/** Build-time precompression (build/precompress.ts): the server serves these
 *  siblings to clients that accept them, so they must decode to the original. */
describe("precompressDir", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "precompress-"));
    mkdirSync(join(dir, "assets"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes .br and .gz for a large compressible asset, and both decode to the original", () => {
    const js = `export const x = ${JSON.stringify("abc".repeat(2000))};\n`;
    const file = join(dir, "assets", "index-abc.js");
    writeFileSync(file, js);
    const [r] = precompressDir(dir);
    expect(r.br).toBeLessThan(r.raw);
    expect(r.gz).toBeLessThan(r.raw);
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).toString()).toBe(
      js,
    );
    expect(gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(js);
  });

  it("skips files under 1KB and non-compressible types", () => {
    writeFileSync(join(dir, "index.html"), "<!doctype html><p>tiny</p>");
    writeFileSync(join(dir, "assets", "logo.png"), Buffer.alloc(4096, 7));
    expect(precompressDir(dir)).toEqual([]);
    expect(existsSync(join(dir, "index.html.br"))).toBe(false);
    expect(existsSync(join(dir, "assets", "logo.png.gz"))).toBe(false);
  });

  it("never writes a variant that is larger than the original", () => {
    // Random bytes don't compress: both variants would be bigger.
    const noise = randomBytes(4096);
    const file = join(dir, "assets", "noise.js");
    writeFileSync(file, noise);
    const [r] = precompressDir(dir);
    expect(r.br).toBeNull();
    expect(r.gz).toBeNull();
    expect(existsSync(`${file}.br`)).toBe(false);
    expect(existsSync(`${file}.gz`)).toBe(false);
  });
});
