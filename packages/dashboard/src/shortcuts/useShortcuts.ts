import { useEffect } from "react";
import { matchShortcut } from "./registry";

/** True when focus is in an editable TEXT field the user is typing in —
 *  excluding xterm's hidden helper textarea, which is the terminal's input
 *  proxy (shortcuts must still win there; that is the whole boundary). */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/**
 * The global shortcut dispatcher — ONE window-level capture-phase listener
 * over the whole app (the generalization of the old inline Cmd/Ctrl+B
 * handler, same capture rationale: xterm stopPropagation()s handled keys in
 * the bubble phase, so only capture listeners see them).
 *
 * `enabled` gates on auth: the old handler also fired on the login screen,
 * over the password field.
 *
 * For app-reserved matches we stopPropagation() in addition to
 * preventDefault(): window capture runs before xterm's textarea capture
 * listener, so this is what keeps a reserved chord out of the terminal
 * entirely (xterm's own registry consult is the backstop, not the mechanism).
 */
export function useShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Mid-IME-composition keys belong to the IME — Escape cancels the
      // composition, and must not also dismiss a panel. (Reachable since
      // Escape became the registry's first bare chord, ADR-065.)
      if (e.isComposing) return;
      const shortcut = matchShortcut(e);
      if (!shortcut) return;
      // Chords with native text-editing meanings pass through while the user
      // is typing in a real field (mod+arrows = caret motion) — no consume,
      // so the field keeps its native behavior.
      if (shortcut.skipWhenEditing && isEditingTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        shortcut.run();
      } catch (err) {
        // The event is already consumed; an uncaught throw here would vanish
        // into the window listener with no React boundary. Surface it.
        console.error(`[autonomOS] shortcut ${shortcut.id} failed:`, err);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
