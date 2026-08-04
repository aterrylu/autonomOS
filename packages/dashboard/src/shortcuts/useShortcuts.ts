import { useEffect } from "react";
import { matchShortcut } from "./registry";

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
