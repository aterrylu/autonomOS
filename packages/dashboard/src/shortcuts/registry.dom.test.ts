// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { isMac } from "../utils/platform";
import type { ChordEvent } from "./chord";
import { pushEscapeCloser } from "./escapeStack";
import { isReservedChord, matchShortcut, SHORTCUTS } from "./registry";

/**
 * Registry invariants — the conflict checker. Adding a shortcut that violates
 * the key-capture boundary or double-books a chord fails HERE, not in a
 * user's terminal.
 */

/** Chords Chrome refuses to hand to the page (Chromium's reserved command
 *  keys). Registering one would ship a shortcut that can never fire. */
const BROWSER_RESERVED = new Set([
  "mod+w",
  "mod+shift+w",
  "mod+t",
  "mod+shift+t",
  "mod+n",
  "mod+shift+n",
  "mod+q",
]);

/** Ctrl-chords with hard shell/readline/tty meanings. On mac these are the
 *  SECONDARY modifier ("ctrl+" prefix in chord.ts terms) and must stay with
 *  the terminal; on other platforms ctrl IS "mod", so any "mod+<letter>"
 *  entry here is a deliberate, documented steal (mod+b is grandfathered —
 *  xterm's handleKeyEvent has declined ctrl+b since before this registry). */
const TERMINAL_SACRED = new Set([
  "ctrl+a",
  "ctrl+c",
  "ctrl+d",
  "ctrl+e",
  "ctrl+k",
  "ctrl+l",
  "ctrl+r",
  "ctrl+u",
  "ctrl+w",
  "ctrl+z",
]);

function event(partial: Partial<ChordEvent>): ChordEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

function modEvent(partial: Partial<ChordEvent>): ChordEvent {
  return event(
    isMac ? { metaKey: true, ...partial } : { ctrlKey: true, ...partial },
  );
}

describe("registry invariants", () => {
  it("has no duplicate chords", () => {
    const chords = SHORTCUTS.map((s) => s.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers nothing the browser reserves for itself", () => {
    for (const s of SHORTCUTS) {
      expect(BROWSER_RESERVED.has(s.chord), s.chord).toBe(false);
    }
  });

  it("registers no mac-secondary ctrl chords (terminal-sacred)", () => {
    for (const s of SHORTCUTS) {
      expect(TERMINAL_SACRED.has(s.chord), s.chord).toBe(false);
      expect(s.chord.startsWith("ctrl+"), s.chord).toBe(false);
    }
  });

  it("every mod+ chord documents its non-Mac (mod = Ctrl) terminal cost", () => {
    // On Linux/Windows `mod` IS Ctrl, so a "mod+x" entry reserves Ctrl+x there
    // — chords with real shell/xterm meanings (review catch on ADR-063: mod+3
    // resolves to ctrl+3, whose xterm encoding is ESC). This table forces every
    // such steal to be a CONSCIOUS, documented decision: registering a new
    // mod+ chord without an entry here fails, so e.g. a future "mod+r" cannot
    // silently eat readline reverse-search on Linux.
    const NON_MAC_COST: Record<string, string> = {
      "mod+1": "none — xterm sends nothing for ctrl+1",
      "mod+2": "none — xterm sends nothing for ctrl+2",
      "mod+3": "STEALS ctrl+3 (xterm encodes ESC) — accepted, ADR-063",
      "mod+4": "STEALS ctrl+4 (FS) — accepted, ADR-063",
      "mod+5": "STEALS ctrl+5 (GS) — accepted, ADR-063",
      "mod+6": "STEALS ctrl+6 (RS; vim alternate-file) — accepted, ADR-063",
      "mod+7": "STEALS ctrl+7 (US) — accepted, ADR-063",
      "mod+8": "STEALS ctrl+8 (xterm encodes DEL) — accepted, ADR-063",
      "mod+9": "none — xterm sends nothing for ctrl+9",
      "mod+b":
        "STEALS ctrl+b (readline back-char, tmux prefix) — grandfathered: xterm's handleKeyEvent declined it pre-registry",
      "mod+/":
        "minor — ctrl+/ is undo in some readline builds; standard app help chord",
    };
    for (const s of SHORTCUTS) {
      if (!s.chord.startsWith("mod+")) continue;
      expect(
        NON_MAC_COST[s.chord],
        `"${s.chord}" has no documented non-Mac cost — on Linux/Windows it reserves Ctrl+${s.chord.slice(4)}; add a NON_MAC_COST entry (a conscious decision), don't just register it`,
      ).toBeDefined();
    }
  });

  it("covers mod+1..9 agent switching", () => {
    for (let n = 1; n <= 9; n++) {
      expect(SHORTCUTS.some((s) => s.chord === `mod+${n}`)).toBe(true);
    }
  });
});

describe("matchShortcut / isReservedChord", () => {
  it("matches mod+digit to the agent shortcut", () => {
    const m = matchShortcut(modEvent({ key: "3", code: "Digit3" }));
    expect(m?.id).toBe("agent.focus.3");
  });

  it("does not match a bare digit", () => {
    expect(matchShortcut(event({ key: "3", code: "Digit3" }))).toBeNull();
  });

  it("reserves Escape ONLY while something is on the escape stack", () => {
    const esc = event({ key: "Escape", code: "Escape" });
    expect(matchShortcut(esc)).toBeNull();
    expect(isReservedChord(esc)).toBe(false);

    const closer = vi.fn();
    const pop = pushEscapeCloser(closer);
    expect(matchShortcut(esc)?.id).toBe("ui.dismiss");
    expect(isReservedChord(esc)).toBe(true);
    matchShortcut(esc)?.run();
    expect(closer).toHaveBeenCalledTimes(1);

    pop();
    expect(matchShortcut(esc)).toBeNull();
    expect(isReservedChord(esc)).toBe(false);
  });

  it("isReservedChord is true for digit chords (xterm must decline them)", () => {
    expect(isReservedChord(modEvent({ key: "1", code: "Digit1" }))).toBe(true);
    expect(isReservedChord(modEvent({ key: "b", code: "KeyB" }))).toBe(true);
  });

  it("isReservedChord is false for passthrough chords", () => {
    // ctrl+r (mac secondary) — reverse-search must reach the shell.
    expect(
      isReservedChord(
        event(
          isMac
            ? { ctrlKey: true, key: "r", code: "KeyR" }
            : { key: "r", code: "KeyR" },
        ),
      ),
    ).toBe(false);
  });
});
