// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { isMac } from "../utils/platform";
import type { ChordEvent } from "./chord";
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

  it("covers mod+1..9 pane switching", () => {
    for (let n = 1; n <= 9; n++) {
      expect(SHORTCUTS.some((s) => s.chord === `mod+${n}`)).toBe(true);
    }
  });
});

describe("matchShortcut / isReservedChord", () => {
  it("matches mod+digit to the pane shortcut", () => {
    const m = matchShortcut(modEvent({ key: "3", code: "Digit3" }));
    expect(m?.id).toBe("pane.focus.3");
  });

  it("does not match a bare digit", () => {
    expect(matchShortcut(event({ key: "3", code: "Digit3" }))).toBeNull();
  });

  it("reserves Escape ONLY while the help overlay is open", () => {
    const esc = event({ key: "Escape", code: "Escape" });
    useStore.setState({ shortcutHelpOpen: false });
    expect(matchShortcut(esc)).toBeNull();
    expect(isReservedChord(esc)).toBe(false);

    useStore.setState({ shortcutHelpOpen: true });
    expect(matchShortcut(esc)?.id).toBe("help.close");
    expect(isReservedChord(esc)).toBe(true);
    useStore.setState({ shortcutHelpOpen: false });
  });

  it("isReservedChord is true for pane chords (xterm must decline them)", () => {
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
