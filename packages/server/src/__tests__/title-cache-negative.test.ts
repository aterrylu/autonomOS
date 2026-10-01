/**
 * titleCache caches "no custom title" too.
 *
 * Most sessions never get a custom title. Before, an untitled transcript was
 * dropped from the cache and fully re-read (tail, head, and the whole middle
 * of a large file) on every Projects poll — a recurring ~150ms event-loop
 * block on a 25-agent load rig, which is enough to time out statusline
 * requests that land in it.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { batchGetTitles, cwdToDirName } from "../titleCache";

describe("titleCache negative results", () => {
  const prevHome = process.env.HOME;
  let home: string;
  let cwd: string;
  let file: string;
  const SID = "11111111-2222-3333-4444-555555555555";
  // A titled session in the same project dir: proves the lookup resolves the
  // dir at all, so an "undefined" below can only mean "no title".
  const CONTROL = "99999999-2222-3333-4444-555555555555";
  const head = `${JSON.stringify({ type: "user", message: "hi" })}\n`;
  const titled = `${head}${JSON.stringify({ type: "custom-title", customTitle: "Named" })}\n`;
  // Same byte length as `titled`, no title: swapping one for the other keeps
  // the size, so only mtime+size caching can still answer "no title".
  const untitled = `${head}${JSON.stringify({ type: "user", pad: "" }).padEnd(titled.length - head.length - 1, " ")}\n`;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "title-neg-"));
    process.env.HOME = home;
    cwd = join(home, "work");
    mkdirSync(cwd);
    const dir = join(home, ".claude", "projects", cwdToDirName(cwd));
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${SID}.jsonl`);
    writeFileSync(file, untitled);
    writeFileSync(join(dir, `${CONTROL}.jsonl`), titled);
  });
  after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("an untitled session is served from cache while its mtime is unchanged", async () => {
    // Whole-second mtime, so restoring it below is exact (a Date round-trip
    // drops the sub-millisecond part of mtimeMs).
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(file, pinned, pinned);
    const first = await batchGetTitles([
      { sessionId: SID, cwd },
      { sessionId: CONTROL, cwd },
    ]);
    assert.equal(first.get(CONTROL), "Named", "precondition: dir resolved");
    assert.equal(first.get(SID), undefined);

    // Same mtime AND size, different bytes: only a cache hit can still say
    // "no title".
    writeFileSync(file, titled);
    utimesSync(file, pinned, pinned);
    assert.equal(statSync(file).mtimeMs, pinned.getTime()); // precondition
    assert.equal(statSync(file).size, untitled.length); // precondition
    const second = await batchGetTitles([{ sessionId: SID, cwd }]);
    assert.equal(second.get(SID), undefined, "negative result must be cached");
  });

  it("a grown file re-scans even within the same mtime tick", async () => {
    const pinned = statSync(file).mtime;
    writeFileSync(file, `${titled}${head}`); // appended, mtime pinned back
    utimesSync(file, pinned, pinned);
    const grown = await batchGetTitles([{ sessionId: SID, cwd }]);
    assert.equal(grown.get(SID), "Named");
  });

  it("a changed mtime re-scans and finds the new title", async () => {
    writeFileSync(file, titled);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const third = await batchGetTitles([{ sessionId: SID, cwd }]);
    assert.equal(third.get(SID), "Named");
  });
});
