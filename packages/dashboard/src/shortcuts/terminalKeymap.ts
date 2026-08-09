/**
 * Terminal-scoped mod-key bindings — the LAST hand-list from before the
 * registry, now data (ADR-065 flagged it; this closes it). These need the
 * live terminal/socket, so they are consumed by xterm's handleKeyEvent, not
 * the global dispatcher — but like the registry they are one documented,
 * drift-tested table rather than a switch statement.
 *
 * Matching: printed key, lowercased (CapsLock-safe, layout-consistent with
 * chord.ts — deliberately NOT event.code, which would remap on Dvorak).
 * `shift`: "required" | "forbidden" | "any" — the old switch matched raw
 * event.key, so e.g. mod+Shift+A fell through to xterm; that behavior is
 * preserved explicitly.
 *
 * ONE intentional divergence from the old switch (review catch): under
 * CapsLock-on + no-Shift, the old `switch (event.key)` saw "A"/"O" and fell to
 * default (passed to xterm); lowercasing first makes CapsLock+a fire the
 * `forbidden` select-all / send, which is the MORE consistent behavior and is
 * pinned in terminalKeymap.test.ts as a decision, not a side effect.
 */

export type TerminalKeyActionSpec =
  /** Write control bytes to the PTY socket. */
  | { type: "send"; bytes: string }
  /** Clear the local scrollback. */
  | { type: "clear" }
  /** Select the whole buffer locally. */
  | { type: "selectAll" }
  /** Decline: xterm must not encode it (event still propagates). */
  | { type: "decline" };

export interface TerminalKeyBinding {
  /** Printed key, lowercased ("k", "w", "backspace", "arrowleft"…). */
  key: string;
  shift: "required" | "forbidden" | "any";
  action: TerminalKeyActionSpec;
  /** Why this binding exists — the NON_MAC_COST discipline, terminal-side. */
  why: string;
}

export const TERMINAL_MOD_KEYMAP: TerminalKeyBinding[] = [
  {
    key: "k",
    shift: "required",
    action: { type: "clear" },
    why: "clear scrollback — moved off plain mod+K by the quick-switcher ADR; printed-letter match keeps CapsLock working and Dvorak un-stolen",
  },
  {
    key: "w",
    shift: "any",
    action: { type: "decline" },
    why: "browser-owned close-tab/close-window (unpreventable off-Mac): declining stops xterm invisibly deleting a word from the shell line as the tab dies (ADR-065 kept this deliberately)",
  },
  {
    key: "a",
    shift: "forbidden",
    action: { type: "selectAll" },
    why: "select-all of the local buffer (browser convention)",
  },
  {
    key: "backspace",
    // "any": the pre-registry switch matched the raw key string, which does
    // not change under Shift for named keys — preserved exactly.
    shift: "any",
    action: { type: "send", bytes: "\x15" },
    why: "mod+Backspace = kill-line-backward (readline ctrl+u), the mac-wide delete-to-start idiom",
  },
  {
    key: "arrowleft",
    // "any": the pre-registry switch matched the raw key string, which does
    // not change under Shift for named keys — preserved exactly.
    shift: "any",
    action: { type: "send", bytes: "\x01" },
    why: "mod+← = line start (readline ctrl+a), the mac-wide Home idiom",
  },
  {
    key: "arrowright",
    // "any": the pre-registry switch matched the raw key string, which does
    // not change under Shift for named keys — preserved exactly.
    shift: "any",
    action: { type: "send", bytes: "\x05" },
    why: "mod+→ = line end (readline ctrl+e), the mac-wide End idiom",
  },
  {
    key: "o",
    shift: "forbidden",
    action: { type: "send", bytes: "\x0f" },
    why: "mod+O = operate-and-get-next (readline ctrl+o) — pre-registry behavior, preserved",
  },
];

/** The binding a keydown activates, or null. */
export function matchTerminalKey(event: {
  key: string;
  shiftKey: boolean;
}): TerminalKeyBinding | null {
  const key = event.key.toLowerCase();
  for (const b of TERMINAL_MOD_KEYMAP) {
    if (b.key !== key) continue;
    if (b.shift === "required" && !event.shiftKey) continue;
    if (b.shift === "forbidden" && event.shiftKey) continue;
    return b;
  }
  return null;
}
