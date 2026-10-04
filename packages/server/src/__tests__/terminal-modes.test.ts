/**
 * DecModeTracker: the sticky terminal modes a reconnect replay must restore.
 * Fixtures are REAL streams captured from a rig (Codex 0.154, Claude Code
 * 2.1.x with CLAUDE_CODE_NO_FLICKER=1), chunk boundaries preserved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DecModeTracker } from "../agents/terminalModes.js";

const fixture = (name: string): string[] =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/tui-stream-${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const CODEX = fixture("codex");
const CLAUDE = fixture("claude");

const MODES = [
  1, 25, 47, 1047, 1049, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 2004,
];
const snapshot = (t: DecModeTracker) =>
  Object.fromEntries(MODES.map((m) => [m, t.isOn(m)]));
const feedAll = (t: DecModeTracker, chunks: string[]) => {
  for (const c of chunks) t.feed(c);
  return t;
};

describe("DecModeTracker on real TUI streams", () => {
  it("Codex: alternate screen + alternate scroll are on after its startup", () => {
    const t = feedAll(new DecModeTracker(), CODEX);
    assert.equal(t.inAltScreen(), true);
    assert.equal(t.isOn(1007), true, "the wheel → arrow-keys mode");
  });

  it("Claude no_flicker: alternate screen + mouse tracking are on", () => {
    const t = feedAll(new DecModeTracker(), CLAUDE);
    assert.equal(t.inAltScreen(), true);
    for (const m of [1000, 1002, 1003, 1006]) assert.equal(t.isOn(m), true);
  });

  for (const [name, stream] of [
    ["codex", CODEX],
    ["claude", CLAUDE],
  ] as const) {
    it(`${name}: head preamble + the retained chunks ends in the LIVE state, at every trim point`, () => {
      const live = feedAll(new DecModeTracker(), stream);
      const step = Math.max(1, Math.floor(stream.length / 60));
      for (let cut = 0; cut <= stream.length; cut += step) {
        // The trim drops chunks [0, cut) from the front, feeding the head.
        const head = feedAll(new DecModeTracker(), stream.slice(0, cut));
        const replayed = new DecModeTracker();
        replayed.feed(head.preamble());
        feedAll(replayed, stream.slice(cut));
        assert.deepEqual(snapshot(replayed), snapshot(live), `cut=${cut}`);
      }
    });

    it(`${name}: WITHOUT the preamble a trimmed replay loses the modes (the bug)`, () => {
      const k = stream.findIndex((c) => c.includes("\x1b[?1049h"));
      const replayed = feedAll(new DecModeTracker(), stream.slice(k + 1));
      assert.equal(replayed.inAltScreen(), false);
    });
  }
});

describe("DecModeTracker parsing", () => {
  it("handles a mode sequence split across chunks at EVERY byte offset", () => {
    const seq = "abc\x1b[?1049;1007hdef\x1b[?25l";
    for (let k = 0; k <= seq.length; k++) {
      const t = new DecModeTracker();
      t.feed(seq.slice(0, k));
      t.feed(seq.slice(k));
      assert.equal(t.isOn(1049), true, `split at ${k}`);
      assert.equal(t.isOn(1007), true, `split at ${k}`);
      assert.equal(t.isOn(25), false, `split at ${k}`);
    }
  });

  it("multi-param sets, later wins, untracked modes ignored", () => {
    const t = new DecModeTracker();
    t.feed("\x1b[?1000;1006h\x1b[?1000l\x1b[?2026h\x1b[?12h");
    assert.equal(t.isOn(1000), false);
    assert.equal(t.isOn(1006), true);
    assert.equal(t.preamble(), "\x1b[?1006h", "2026/12 are not sticky");
  });

  it("RIS (ESC c) resets every mode", () => {
    const t = new DecModeTracker();
    t.feed("\x1b[?1049h\x1b[?25l\x1bc");
    assert.equal(t.inAltScreen(), false);
    assert.equal(t.isOn(25), true);
    assert.equal(t.preamble(), "");
  });

  it("preamble: alternate screen first, defaults omitted, a hidden cursor emitted", () => {
    const t = new DecModeTracker();
    t.feed("\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[?1h\x1b[?1l");
    assert.equal(t.preamble(), "\x1b[?1049h\x1b[?2004h\x1b[?25l");
    assert.equal(new DecModeTracker().preamble(), "");
  });

  it("does not grow an unbounded carry from a long non-mode run", () => {
    const t = new DecModeTracker();
    t.feed(`\x1b[?${"1".repeat(200)}`); // never terminated
    t.feed("\x1b[?1049h");
    assert.equal(t.inAltScreen(), true);
  });
});
