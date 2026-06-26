import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripReplayDeviceQueries } from "../routes/terminal.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

describe("stripReplayDeviceQueries", () => {
  it("strips device-attribute requests/responses (DA1/DA2/DA3)", () => {
    assert.equal(stripReplayDeviceQueries(`${ESC}[c`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[>c`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[>0;276;0c`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[?1;2c`), "");
  });

  it("strips device-status / cursor-position reports (DSR/CPR)", () => {
    assert.equal(stripReplayDeviceQueries(`${ESC}[5n`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[6n`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[?6n`), "");
  });

  it("strips DECRQM mode queries (e.g. synchronized output ?2026)", () => {
    assert.equal(stripReplayDeviceQueries(`${ESC}[?2026$p`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[?1$p`), "");
  });

  it("strips XTVERSION requests and kitty keyboard-flag queries", () => {
    assert.equal(stripReplayDeviceQueries(`${ESC}[>q`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[>0q`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[?u`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}[?1u`), "");
  });

  it("strips OSC color/palette queries (BEL- and ST-terminated)", () => {
    assert.equal(stripReplayDeviceQueries(`${ESC}]10;?${BEL}`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}]11;?${ST}`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}]12;?${BEL}`), "");
    assert.equal(stripReplayDeviceQueries(`${ESC}]4;1;?${BEL}`), "");
  });

  it("PRESERVES visible/display sequences (SGR, erase, cursor moves)", () => {
    // These render output / move the cursor and must survive the replay.
    const display = [
      `${ESC}[31m`, // SGR red
      `${ESC}[0m`, // SGR reset
      `${ESC}[2J`, // erase display
      `${ESC}[10;1H`, // cursor position SET (not a report)
      `${ESC}[2K`, // erase line
      `${ESC}[2 q`, // DECSCUSR cursor style (space intermediate, has 'q')
      `${ESC}]0;my title${BEL}`, // OSC window-title set (not a query)
      `${ESC}[?2004h`, // bracketed-paste enable (mode SET)
    ].join("");
    assert.equal(stripReplayDeviceQueries(display), display);
  });

  it("preserves surrounding text while removing only the query", () => {
    const input = `hello ${ESC}[31mworld${ESC}[0m${ESC}[6n done`;
    assert.equal(
      stripReplayDeviceQueries(input),
      `hello ${ESC}[31mworld${ESC}[0m done`,
    );
  });

  it("strips a query whether or not it straddles a former chunk boundary (concat-then-strip)", () => {
    // Simulate two PTY chunks where the query was split: ESC[6 | n
    const chunks = [`prompt>${ESC}[6`, `n more text`];
    assert.equal(
      stripReplayDeviceQueries(chunks.join("")),
      "prompt> more text",
    );
  });

  it("removes a realistic startup query burst from scrollback", () => {
    const scrollback =
      `${ESC}[?1049h${ESC}[2J${ESC}[H` + // alt screen + clear (KEEP)
      `${ESC}[c${ESC}[>c${ESC}[?u${ESC}[?2026$p${ESC}]11;?${BEL}` + // queries (STRIP)
      `${ESC}[1;32mClaude Code${ESC}[0m\n> `; // visible prompt (KEEP)
    assert.equal(
      stripReplayDeviceQueries(scrollback),
      `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[1;32mClaude Code${ESC}[0m\n> `,
    );
  });
});
