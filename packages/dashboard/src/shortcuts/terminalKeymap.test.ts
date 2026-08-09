import { describe, expect, it } from "vitest";
import { matchTerminalKey, TERMINAL_MOD_KEYMAP } from "./terminalKeymap";

describe("terminal keymap table", () => {
  it("every binding documents why it exists", () => {
    for (const b of TERMINAL_MOD_KEYMAP) {
      expect(b.why.length, b.key).toBeGreaterThan(10);
    }
  });

  it("no duplicate (key, shift-overlapping) bindings", () => {
    for (const a of TERMINAL_MOD_KEYMAP) {
      const overlapping = TERMINAL_MOD_KEYMAP.filter(
        (b) =>
          b !== a &&
          b.key === a.key &&
          (a.shift === "any" || b.shift === "any" || a.shift === b.shift),
      );
      expect(overlapping, a.key).toHaveLength(0);
    }
  });

  it("shift semantics: required, forbidden, any", () => {
    // clear requires shift
    expect(matchTerminalKey({ key: "K", shiftKey: true })?.action.type).toBe(
      "clear",
    );
    expect(matchTerminalKey({ key: "k", shiftKey: false })).toBeNull();
    // select-all forbids shift (mod+shift+A fell through pre-registry too)
    expect(matchTerminalKey({ key: "a", shiftKey: false })?.action.type).toBe(
      "selectAll",
    );
    expect(matchTerminalKey({ key: "A", shiftKey: true })).toBeNull();
    // decline matches any shift state
    expect(matchTerminalKey({ key: "w", shiftKey: false })?.action.type).toBe(
      "decline",
    );
    expect(matchTerminalKey({ key: "W", shiftKey: true })?.action.type).toBe(
      "decline",
    );
    // named keys keep their pre-registry any-shift behavior
    expect(
      matchTerminalKey({ key: "Backspace", shiftKey: true })?.action,
    ).toEqual({ type: "send", bytes: "\x15" });
  });

  it("CapsLock: printed-letter matching fires forbidden-shift letters (intended divergence)", () => {
    // Old switch(event.key) saw "A"/"O" under CapsLock and fell through to
    // xterm; lowercasing first makes CapsLock+a fire select-all. Pinned as a
    // deliberate decision (the more consistent behavior), NOT a side effect.
    expect(matchTerminalKey({ key: "A", shiftKey: false })?.action.type).toBe(
      "selectAll",
    );
    expect(matchTerminalKey({ key: "O", shiftKey: false })?.action).toEqual({
      type: "send",
      bytes: "\x0f",
    });
    // But CapsLock + Shift on a letter still cancels to lowercase-with-shift,
    // and a `forbidden` entry declines it (matches old fall-through).
    expect(matchTerminalKey({ key: "a", shiftKey: true })).toBeNull();
  });

  it("unbound keys return null (xterm handles them)", () => {
    expect(matchTerminalKey({ key: "r", shiftKey: false })).toBeNull();
    expect(matchTerminalKey({ key: "Enter", shiftKey: false })).toBeNull();
  });
});
