import { useStore } from "../store";
import { focusAgentByIndex, focusAgentDelta } from "./actions";
import { type ChordEvent, eventChord } from "./chord";
import { closeTopEscape, hasEscapeCloser } from "./escapeStack";

/**
 * The keyboard shortcut registry — the single source of truth for every
 * app-level chord (ADR: keyboard shortcut registry & the key-capture boundary).
 *
 * TWO enforcement points consume this table, and only this table:
 *   1. useShortcuts — ONE window-level CAPTURE-phase dispatcher. Capture is
 *      mandatory: xterm.js stopPropagation()s every key it handles in the
 *      bubble phase, so bubble listeners are dead while a terminal is focused.
 *      On an app-reserved match it preventDefault+stopPropagation+runs, so a
 *      focused terminal never sees the chord at all.
 *   2. handleKeyEvent (useTerminal.ts) — xterm's attachCustomKeyEventHandler
 *      consults isReservedChord() and declines reserved chords (returns
 *      false). In practice the dispatcher's stopPropagation already keeps
 *      them from xterm; the consult is defense in depth that keeps the
 *      terminal's decline list mechanically synchronized with this registry.
 *
 * Adding a shortcut = one entry here. registry.dom.test.ts enforces the
 * invariants (no duplicate chords, nothing browser-unreservable, terminal-
 * sacred ctrl-chords need an explicit rationale).
 *
 * IMPORT-CYCLE DISCIPLINE: useTerminal → this module → actions → useTerminal
 * is a real cycle, safe only because every cross-cycle binding is a hoisted
 * `function` declaration referenced at call time (every `run` closure below
 * reads cross-cycle bindings at CALL time; a top-level read of one would be
 * a TDZ crash for a `const` arrow). Keep exported cross-cycle functions as declarations.
 */

/**
 * Every v1 chord wins over a focused terminal — the terminal never sees it.
 * The design (ADR) also names an "app-when-free" class (fires only when no
 * terminal/editable element has focus — what a bare-letter shortcut like `?`
 * would need). Deliberately NOT carried as a union member until its first
 * shortcut ships: widening the type is one line, and dead branches in the
 * dispatcher would otherwise claim a behavior nothing exercises.
 */
export type ShortcutBoundary = "app-reserved";

export interface ShortcutDef {
  /** Stable command id, e.g. "agent.focus.3". Never shown to users. */
  id: string;
  /** Normalized chord (see chord.ts): "mod+3", "mod+b", "escape". */
  chord: string;
  /** Help-overlay text. */
  description: string;
  /** Help-overlay grouping. */
  category: "Agents" | "App";
  boundary: ShortcutBoundary;
  /** Extra gate (beyond auth) — e.g. "only while the help overlay is open".
   *  A false `when` makes the chord pass through untouched. */
  when?: () => boolean;
  run: () => void;
}

const agentShortcuts: ShortcutDef[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
  id: `agent.focus.${n}`,
  chord: `mod+${n}`,
  description: `Switch to agent ${n}`,
  category: "Agents",
  boundary: "app-reserved",
  run: () => focusAgentByIndex(n - 1),
}));

export const SHORTCUTS: ShortcutDef[] = [
  ...agentShortcuts,
  {
    id: "agent.prev",
    chord: "mod+arrowup",
    description: "Previous agent",
    category: "Agents",
    boundary: "app-reserved",
    run: () => focusAgentDelta(-1),
  },
  {
    id: "agent.next",
    chord: "mod+arrowdown",
    description: "Next agent",
    category: "Agents",
    boundary: "app-reserved",
    run: () => focusAgentDelta(1),
  },
  {
    id: "sidebar.toggle",
    chord: "mod+b",
    description: "Toggle sidebar",
    category: "App",
    boundary: "app-reserved",
    run: () => useStore.getState().toggleSidebar(),
  },
  {
    id: "help.toggle",
    chord: "mod+/",
    description: "Show keyboard shortcuts",
    category: "App",
    boundary: "app-reserved",
    run: () => useStore.getState().toggleShortcutHelp(),
  },
  {
    id: "ui.dismiss",
    chord: "escape",
    description: "Close the topmost overlay or panel",
    category: "App",
    boundary: "app-reserved",
    // Escape is reserved ONLY while something dismissible is open (help
    // overlay, status-bar popovers, notification panel — they register on the
    // escape stack while mounted). Otherwise it passes through untouched:
    // terminal TUIs depend on receiving Escape.
    when: hasEscapeCloser,
    run: closeTopEscape,
  },
];

/** The registry entry a keydown event activates, or null (respects `when`). */
export function matchShortcut(e: ChordEvent): ShortcutDef | null {
  const chord = eventChord(e);
  return (
    SHORTCUTS.find((s) => s.chord === chord && (s.when?.() ?? true)) ?? null
  );
}

/**
 * Whether xterm must decline this event (consulted by handleKeyEvent).
 * True only for app-reserved chords whose `when` gate is currently open.
 */
export function isReservedChord(e: ChordEvent): boolean {
  return matchShortcut(e)?.boundary === "app-reserved";
}
