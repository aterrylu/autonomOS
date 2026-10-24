/**
 * titleCache scans a session file once, then only what was appended.
 *
 * An active session grows every turn, so a (path, mtime, size) cache alone
 * re-read the WHOLE file on every Projects poll whenever it held no custom
 * title — on a server with large session dirs that meant re-streaming
 * hundreds of MB per active session per poll. Session files are append-only,
 * so a grown file is scanned from where the last scan stopped.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { batchGetTitles, cwdToDirName } from "../titleCache";

const titleLine = (t: string) =>
  `${JSON.stringify({ type: "custom-title", customTitle: t })}\n`;
const turn = (n: number) =>
  `${JSON.stringify({ type: "assistant", text: "t".repeat(n) })}\n`;

describe("titleCache incremental scan", () => {
  const prevHome = process.env.HOME;
  let home: string;
  let cwd: string;
  let dir: string;
  let n = 0;
  const sid = () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  const title = async (id: string) =>
    (await batchGetTitles([{ sessionId: id, cwd }])).get(id);

  before(() => {
    home = mkdtempSync(join(tmpdir(), "title-inc-"));
    process.env.HOME = home;
    cwd = join(home, "work");
    mkdirSync(cwd);
    dir = join(home, ".claude", "projects", cwdToDirName(cwd));
    mkdirSync(dir, { recursive: true });
  });
  after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("finds a title in the MIDDLE of a large file (outside head and tail)", async () => {
    const id = sid();
    const file = join(dir, `${id}.jsonl`);
    const filler = turn(4000).repeat(200); // ~800KB
    writeFileSync(file, `${filler}${titleLine("Middle")}${filler}`);
    assert.equal(await title(id), "Middle");
  });

  it("assembles a title line that straddles chunk boundaries", async () => {
    const id = sid();
    const file = join(dir, `${id}.jsonl`);
    // Push the title line to start just before the 256KB boundary, and pad it
    // past the next one with multi-byte characters.
    const lead = turn(256 * 1024 - 40);
    const long = `${JSON.stringify({ type: "custom-title", customTitle: "Straddle", pad: "é".repeat(300 * 1024) })}\n`;
    writeFileSync(file, `${lead}${long}${turn(10)}`);
    assert.equal(await title(id), "Straddle");
  });

  it("a rename appended later is found; a half-written line is picked up once complete", async () => {
    const id = sid();
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, turn(1000).repeat(10));
    assert.equal(await title(id), undefined);
    const line = titleLine("Later");
    appendFileSync(file, line.slice(0, 20)); // a write in progress
    assert.equal(await title(id), undefined);
    appendFileSync(file, line.slice(20));
    assert.equal(await title(id), "Later");
    appendFileSync(file, turn(50)); // more turns: the title holds
    assert.equal(await title(id), "Later");
    appendFileSync(file, titleLine("Renamed"));
    assert.equal(await title(id), "Renamed");
  });

  it("after the first scan, only APPENDED bytes are read", async () => {
    const id = sid();
    const file = join(dir, `${id}.jsonl`);
    const filler = turn(500);
    writeFileSync(file, filler.repeat(20));
    assert.equal(await title(id), undefined);
    // Plant a title line INSIDE the already-scanned prefix (same length, in
    // place) and append an untitled turn. A full rescan would find "Planted";
    // the incremental one reads only the appended turn.
    const planted = JSON.stringify({
      type: "custom-title",
      customTitle: "Planted",
    });
    const fd = openSync(file, "r+");
    writeSync(fd, planted.padEnd(filler.length - 1, " "), 0);
    closeSync(fd);
    appendFileSync(file, turn(10));
    assert.equal(await title(id), undefined, "the scanned prefix was re-read");
  });

  it("a file that SHRANK (rewritten) is rescanned from the start", async () => {
    const id = sid();
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, turn(500).repeat(20));
    assert.equal(await title(id), undefined);
    writeFileSync(file, `${titleLine("Rewritten")}${turn(10)}`);
    assert.equal(await title(id), "Rewritten");
  });
});
