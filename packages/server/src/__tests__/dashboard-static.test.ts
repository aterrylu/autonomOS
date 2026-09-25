import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import { Hono } from "hono";
import {
  CACHE_IMMUTABLE,
  CACHE_REVALIDATE,
  mountDashboard,
} from "../dashboardStatic.js";

/**
 * The built dashboard's caching + compression contract. A temp dist (built in
 * before(), never at import) mirrors Vite's output plus the build-time .br/.gz
 * siblings, and a bare Hono app is driven through mountDashboard.
 */

const JS = `console.log(${JSON.stringify("x".repeat(4000))});\n`; // compressible, > 1KB
let dist = "";
let app: Hono;
const extraDirs: string[] = [];

/** A temp dist shaped like Vite's output + the build's .br/.gz siblings. */
function makeDist(entryHash = "abc123"): string {
  const d = mkdtempSync(join(tmpdir(), "dash-static-"));
  mkdirSync(join(d, "assets"));
  writeFileSync(
    join(d, "index.html"),
    `<!doctype html><script type="module" src="/assets/index-${entryHash}.js"></script>`,
  );
  const js = Buffer.from(JS);
  writeFileSync(join(d, "assets", `index-${entryHash}.js`), js);
  writeFileSync(
    join(d, "assets", `index-${entryHash}.js.br`),
    brotliCompressSync(js),
  );
  writeFileSync(join(d, "assets", `index-${entryHash}.js.gz`), gzipSync(js));
  writeFileSync(
    join(d, "sw.js"),
    "self.addEventListener('install', () => {});",
  );
  return d;
}

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

describe("dashboard static serving", () => {
  before(() => {
    dist = makeDist();
    app = new Hono();
    mountDashboard(app, dist);
  });
  after(() => {
    for (const d of [dist, ...extraDirs])
      rmSync(d, { recursive: true, force: true });
  });

  it("hashed assets: brotli when accepted, immutable, Vary, and the body round-trips", async () => {
    const res = await get("/assets/index-abc123.js", {
      "Accept-Encoding": "gzip, br",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Encoding"), "br");
    assert.equal(res.headers.get("Cache-Control"), CACHE_IMMUTABLE);
    assert.equal(res.headers.get("Vary"), "Accept-Encoding");
    assert.match(res.headers.get("Content-Type") ?? "", /javascript/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(brotliDecompressSync(body).toString(), JS);
  });

  it("hashed assets: gzip for a gzip-only client", async () => {
    const res = await get("/assets/index-abc123.js", {
      "Accept-Encoding": "gzip",
    });
    assert.equal(res.headers.get("Content-Encoding"), "gzip");
    assert.equal(res.headers.get("Cache-Control"), CACHE_IMMUTABLE);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(gunzipSync(body).toString(), JS);
  });

  it("hashed assets: identity for a client that accepts nothing, still with Vary", async () => {
    const res = await get("/assets/index-abc123.js");
    assert.equal(res.headers.get("Content-Encoding"), null);
    assert.equal(res.headers.get("Cache-Control"), CACHE_IMMUTABLE);
    assert.equal(
      res.headers.get("Vary"),
      "Accept-Encoding",
      "identity responses vary too",
    );
    assert.equal(await res.text(), JS);
  });

  it("index.html: must revalidate, carries an ETag, and answers 304 when unchanged", async () => {
    const first = await get("/");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), CACHE_REVALIDATE);
    const etag = first.headers.get("ETag");
    assert.ok(etag, "has an ETag");
    assert.match(await first.text(), /index-abc123\.js/);

    const again = await get("/", { "If-None-Match": etag });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
    assert.equal(again.headers.get("ETag"), etag);
  });

  it("SPA deep links get the same entry document and validator", async () => {
    const root = await get("/");
    const deep = await get("/agents/some-agent/terminal");
    assert.equal(deep.status, 200);
    assert.equal(deep.headers.get("Cache-Control"), CACHE_REVALIDATE);
    assert.equal(deep.headers.get("ETag"), root.headers.get("ETag"));
    assert.match(await deep.text(), /index-abc123\.js/);
  });

  it("non-hashed public files (sw.js) must revalidate, never be pinned", async () => {
    const res = await get("/sw.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), CACHE_REVALIDATE);
  });

  it("a missing hashed asset is a 404 that is never cached (and never the SPA HTML)", async () => {
    const res = await get("/assets/index-GONE0000.js", {
      "Accept-Encoding": "br",
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(res.headers.get("Content-Type") ?? "", /text\/html/);
    assert.doesNotMatch(await res.text(), /<script/);
  });

  it("a weak validator from a re-encoding proxy still gets a 304", async () => {
    const etag = (await get("/")).headers.get("ETag") ?? "";
    const res = await get("/", { "If-None-Match": `W/${etag}` });
    assert.equal(res.status, 304);
  });

  it("a rebuild without a restart is picked up: new entry, new ETag, currentBuild follows", async () => {
    // Own fixture: this test rewrites index.html and must not leak into others.
    const d = makeDist("OLDHASH1");
    extraDirs.push(d);
    const own = new Hono();
    const mounted = mountDashboard(own, d);
    assert.equal(mounted.currentBuild().build, "index-OLDHASH1.js");
    const oldEtag = (await own.request("/")).headers.get("ETag") ?? "";
    // Size changes, so the stat key changes even within the same mtime tick.
    writeFileSync(
      join(d, "index.html"),
      '<!doctype html><script type="module" src="/assets/index-NEWHASH9.js"></script><!-- rebuilt -->',
    );
    // Checked FIRST, before any page request: /api/host is polled on its own,
    // so currentBuild() must see the rebuild without a request refreshing it.
    assert.equal(mounted.currentBuild().build, "index-NEWHASH9.js");
    const after = await own.request("/agents/x", {
      headers: { "If-None-Match": oldEtag },
    });
    assert.equal(
      after.status,
      200,
      "old validator must not match the new build",
    );
    assert.notEqual(after.headers.get("ETag"), oldEtag);
    assert.match(await after.text(), /index-NEWHASH9\.js/);
  });
});
