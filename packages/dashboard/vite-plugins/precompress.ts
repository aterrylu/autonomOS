import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * Build-time precompression. Writes `<file>.br` and `<file>.gz` next to every
 * compressible build output, which the server's `serveStatic({ precompressed })`
 * sends to clients that accept them. Compressing once at build costs nothing
 * per request. The server previously sent the 1.4MB bundle uncompressed on
 * every load.
 */

const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".webmanifest",
  ".txt",
]);
/** Below this, compression overhead isn't worth a second file. */
const MIN_BYTES = 1024;

export interface PrecompressResult {
  file: string;
  raw: number;
  br: number | null;
  gz: number | null;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** Precompress every eligible file under `dir`. A variant is written only when
 *  it is actually smaller than the original. */
export function precompressDir(dir: string): PrecompressResult[] {
  const results: PrecompressResult[] = [];
  for (const file of walk(dir)) {
    if (!COMPRESSIBLE.has(extname(file))) continue;
    const raw = readFileSync(file);
    if (raw.length < MIN_BYTES) continue;
    const br = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    const gz = gzipSync(raw, { level: 9 });
    const result: PrecompressResult = { file, raw: raw.length, br: null, gz: null };
    if (br.length < raw.length) {
      writeAtomic(`${file}.br`, br);
      result.br = br.length;
    }
    if (gz.length < raw.length) {
      writeAtomic(`${file}.gz`, gz);
      result.gz = gz.length;
    }
    results.push(result);
  }
  return results;
}

/** Write via a temp file + rename. A build killed mid-write (Ctrl-C, full
 *  disk) must never leave a truncated sibling in dist: the running server
 *  would send it to every brotli client as `immutable` for a year. */
function writeAtomic(path: string, data: Buffer): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function precompress(): Plugin {
  let outDir = "";
  return {
    name: "autonomos-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // writeBundle, NOT closeBundle: Rollup also calls closeBundle when the
    // build FAILED, and an error thrown there (e.g. no dist/ on a fresh clone)
    // replaced the real build error. writeBundle only runs after a successful
    // write.
    writeBundle() {
      const results = precompressDir(outDir);
      const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
      const raw = results.reduce((a, r) => a + r.raw, 0);
      const br = results.reduce((a, r) => a + (r.br ?? r.raw), 0);
      const gz = results.reduce((a, r) => a + (r.gz ?? r.raw), 0);
      console.log(
        `[precompress] ${results.length} files: ${kb(raw)} → br ${kb(br)}, gzip ${kb(gz)}`,
      );
    },
  };
}
