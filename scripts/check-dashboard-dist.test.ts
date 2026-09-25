import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { distProblem, unexpectedDistEntries } from "./check-dashboard-dist.ts";

/** scripts/check-dashboard-dist.ts — dist/ must hold only the Vite build. */
describe("check-dashboard-dist", () => {
  let root = "";
  let dist = "";
  let pub = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dash-dist-"));
    dist = join(root, "dist");
    pub = join(root, "public");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(pub);
    for (const f of ["favicon.svg", "manifest.json", "sw.js"]) {
      writeFileSync(join(pub, f), "x");
      writeFileSync(join(dist, f), "x");
    }
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "assets", "index-abc123.js"), "x");
    writeFileSync(join(dist, "assets", "index-abc123.js.br"), "x");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a clean Vite build (index.html, assets/, public/ files, .br/.gz siblings) passes", () => {
    assert.deepEqual(unexpectedDistEntries(dist, pub), []);
    assert.equal(distProblem(dist, pub), null);
  });

  it("no dist at all passes (nothing built, nothing served)", () => {
    assert.deepEqual(unexpectedDistEntries(join(root, "nope"), pub), []);
  });

  it("flags tsc output: compiled src files, subdirs and declarations", () => {
    writeFileSync(join(dist, "store.js"), "x");
    writeFileSync(join(dist, "App.d.ts"), "x");
    mkdirSync(join(dist, "components"));
    writeFileSync(join(dist, "components", "Sidebar.js"), "x");
    const bad = unexpectedDistEntries(dist, pub);
    assert.deepEqual(bad, ["App.d.ts", "components", "store.js"]);
    assert.match(distProblem(dist, pub) ?? "", /App\.d\.ts, components, store\.js/);
  });

  it("flags a declaration even inside assets/", () => {
    writeFileSync(join(dist, "assets", "index.d.ts"), "x");
    assert.deepEqual(unexpectedDistEntries(dist, pub), ["assets/index.d.ts"]);
  });

  it("a NEW public/ file is allowed automatically (the allow-list is derived, not hand-kept)", () => {
    writeFileSync(join(pub, "robots.txt"), "x");
    writeFileSync(join(dist, "robots.txt"), "x");
    assert.deepEqual(unexpectedDistEntries(dist, pub), []);
  });
});
