import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { judge, measure } from "./check-bundle-budget";

/** scripts/check-bundle-budget.ts — the dashboard bundle-size ratchet. */

describe("bundle budget", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-budget-"));
    writeFileSync(join(dir, "index-a.js"), "x".repeat(50_000));
    writeFileSync(join(dir, "index-b.css"), "a{b:c}".repeat(2_000));
    // precompressed copies and other assets are not counted
    writeFileSync(join(dir, "index-a.js.gz"), "ignored");
    writeFileSync(join(dir, "logo.svg"), "<svg/>");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("measures gzip -9 of .js and .css only", () => {
    const m = measure(dir);
    assert.deepEqual(
      m.files.map((f) => f.name).sort(),
      ["index-a.js", "index-b.css"],
    );
    assert.ok(m.jsGzipBytes > 0 && m.jsGzipBytes < 50_000, "it gzipped");
    assert.ok(m.cssGzipBytes > 0);
  });

  it("fails a total over budget, naming it and the overage", () => {
    const m = measure(dir);
    const { over } = judge(m, {
      jsGzipBytes: m.jsGzipBytes - 10,
      cssGzipBytes: m.cssGzipBytes,
    });
    assert.equal(over.length, 1);
    assert.match(over[0], /^JS is .* 10 B over its budget/);
  });

  it("passes at or under budget", () => {
    const m = measure(dir);
    assert.deepEqual(
      judge(m, { jsGzipBytes: m.jsGzipBytes, cssGzipBytes: m.cssGzipBytes })
        .over,
      [],
    );
  });

  it("well under budget passes with a note to lower it (the ratchet)", () => {
    const m = measure(dir);
    const { over, notes } = judge(m, {
      jsGzipBytes: m.jsGzipBytes * 2,
      cssGzipBytes: m.cssGzipBytes,
    });
    assert.deepEqual(over, []);
    assert.match(notes[0], /well under .* lower it/);
  });
});
