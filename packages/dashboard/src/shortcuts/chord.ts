import { hasPrimaryModifier, isMac } from "../utils/platform";

/**
 * Structural subset of KeyboardEvent used for chord matching, so pure unit
 * tests can pass plain objects instead of constructing real events.
 */
export interface ChordEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Normalize a keydown event to a chord string: `[mod+][ctrl+|meta+][alt+][shift+]<key>`.
 *
 * - `mod` is the platform primary modifier (⌘ on Mac, Ctrl elsewhere) via
 *   `hasPrimaryModifier` — registry chords are written once and work on both.
 * - The NON-primary modifier is included explicitly (`ctrl` on Mac, `meta`
 *   elsewhere) so e.g. Mac Ctrl+1 can never match the `mod+1` registry entry.
 * - Digits match by PHYSICAL key (`e.code` Digit0-9), not `e.key`: on layouts
 *   where digits are shifted (AZERTY), unshifted `e.key` is a symbol, and
 *   mod+digit shortcuts must follow the printed digit. Shift is dropped for
 *   digits matched this way, since producing the digit may itself require it.
 *   EXCEPTION: when Shift turns the digit key into a DIFFERENT symbol (German
 *   QWERTZ Cmd+Shift+7 = "/"), the user meant the symbol — physical-digit
 *   priority there would silently fire "mod+7" (focus pane 7) on Cmd+/.
 * - Shift is also dropped for printable non-alphanumeric keys ("/" on layouts
 *   where it lives on a shifted position): the symbol already encodes it.
 */
export function eventChord(e: ChordEvent): string {
  const parts: string[] = [];
  if (hasPrimaryModifier(e)) parts.push("mod");
  if (isMac ? e.ctrlKey : e.metaKey) parts.push(isMac ? "ctrl" : "meta");
  if (e.altKey) parts.push("alt");

  const physicalDigit = /^Digit(\d)$/.exec(e.code)?.[1];
  const digit =
    physicalDigit && (!e.shiftKey || e.key === physicalDigit)
      ? physicalDigit
      : undefined;
  const key = digit ?? e.key.toLowerCase();
  const symbolKey = key.length === 1 && !/[a-z0-9]/.test(key);
  if (e.shiftKey && !digit && !symbolKey) parts.push("shift");

  parts.push(key);
  return parts.join("+");
}

/** Modifier labels per platform. Mac renders glyphs run together (⌘⇧B);
 *  everywhere else it's "+"-joined words (Ctrl+Shift+B). */
const MAC_MODIFIERS: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const PC_MODIFIERS: Record<string, string> = {
  mod: "Ctrl",
  meta: "Win",
  alt: "Alt",
  shift: "Shift",
};

/**
 * Human-readable form of a registry chord for the current platform, e.g.
 * `mod+1` → "⌘1" (Mac) / "Ctrl+1" (other), `escape` → "Esc".
 */
export function displayChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts[parts.length - 1] ?? "";
  const keyLabel = key === "escape" ? "Esc" : key.toUpperCase();
  const labels = isMac ? MAC_MODIFIERS : PC_MODIFIERS;
  const mods = parts.slice(0, -1).map((m) => labels[m] ?? m);
  return [...mods, keyLabel].join(isMac ? "" : "+");
}
