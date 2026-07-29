import { describe, expect, it } from "vitest";
import { isMac } from "../utils/platform";
import { displayChord, eventChord } from "./chord";

/** Event with the platform's PRIMARY modifier held (⌘ mac / Ctrl other), so
 *  assertions are environment-independent (same trick as platform.test.ts). */
function mod(partial: Partial<Parameters<typeof eventChord>[0]>) {
  return {
    key: "",
    code: "",
    metaKey: isMac,
    ctrlKey: !isMac,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("eventChord", () => {
  it("normalizes mod+digit via the physical key (code)", () => {
    expect(eventChord(mod({ key: "1", code: "Digit1" }))).toBe("mod+1");
    expect(eventChord(mod({ key: "9", code: "Digit9" }))).toBe("mod+9");
  });

  it("uses the physical digit even when the layout shifts it (AZERTY)", () => {
    // AZERTY: pressing the '1' key produces '&' unshifted.
    expect(eventChord(mod({ key: "&", code: "Digit1" }))).toBe("mod+1");
    // Digits matched by code drop shift — producing the digit may require it.
    expect(eventChord(mod({ key: "1", code: "Digit1", shiftKey: true }))).toBe(
      "mod+1",
    );
  });

  it("normalizes letters case-insensitively", () => {
    expect(eventChord(mod({ key: "b", code: "KeyB" }))).toBe("mod+b");
    expect(eventChord(mod({ key: "B", code: "KeyB", shiftKey: true }))).toBe(
      "mod+shift+b",
    );
  });

  it("drops shift for printable symbols (layout-shifted '/')", () => {
    expect(eventChord(mod({ key: "/", code: "Slash" }))).toBe("mod+/");
    // German QWERTZ: '/' is Shift+7. Shift turned the digit key into a
    // DIFFERENT symbol, so the user meant the symbol — mod+/ (help overlay),
    // NOT mod+7 (which would silently focus pane 7 on Cmd+/).
    expect(eventChord(mod({ key: "/", code: "Digit7", shiftKey: true }))).toBe(
      "mod+/",
    );
    // But when Shift is REQUIRED to produce the digit itself (AZERTY
    // Cmd+Shift+1 → key "1"), the physical digit still wins.
    expect(eventChord(mod({ key: "1", code: "Digit1", shiftKey: true }))).toBe(
      "mod+1",
    );
  });

  it("keeps shift for named keys", () => {
    expect(
      eventChord(
        mod({ key: "Escape", code: "Escape", metaKey: false, ctrlKey: false }),
      ),
    ).toBe("escape");
  });

  it("includes the NON-primary modifier so it cannot alias mod", () => {
    // The secondary modifier (Ctrl on mac, Meta elsewhere) must show up in the
    // chord, so e.g. mac Ctrl+1 never matches the "mod+1" registry entry.
    const secondary = isMac
      ? { metaKey: false, ctrlKey: true }
      : { metaKey: true, ctrlKey: false };
    const chord = eventChord(mod({ key: "1", code: "Digit1", ...secondary }));
    expect(chord).not.toBe("mod+1");
    expect(chord).toBe(isMac ? "ctrl+1" : "meta+1");
  });

  it("plain keys carry no modifier prefix", () => {
    expect(
      eventChord(
        mod({ key: "a", code: "KeyA", metaKey: false, ctrlKey: false }),
      ),
    ).toBe("a");
  });
});

describe("displayChord", () => {
  it("renders the registry's chords for this platform", () => {
    expect(displayChord("mod+1")).toBe(isMac ? "⌘1" : "Ctrl+1");
    expect(displayChord("mod+b")).toBe(isMac ? "⌘B" : "Ctrl+B");
    expect(displayChord("mod+/")).toBe(isMac ? "⌘/" : "Ctrl+/");
  });

  it("stacks multiple modifiers in registry order", () => {
    // Mac runs the glyphs together; other platforms join words with "+".
    expect(displayChord("mod+shift+b")).toBe(isMac ? "⌘⇧B" : "Ctrl+Shift+B");
    expect(displayChord("mod+alt+b")).toBe(isMac ? "⌘⌥B" : "Ctrl+Alt+B");
  });

  it("spells out named keys and needs no modifier", () => {
    expect(displayChord("escape")).toBe("Esc");
  });
});
