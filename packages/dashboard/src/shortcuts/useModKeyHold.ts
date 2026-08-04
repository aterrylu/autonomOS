import { useEffect } from "react";
import { useStore } from "../store";
import { isMac } from "../utils/platform";

/** How long the primary modifier must be held alone before pane-number badges
 *  appear. Long enough that a quick ⌘C / ⌘V / ⌘1 never flashes them; short
 *  enough that a deliberate "which pane is which?" hold feels instant. */
export const MOD_HOLD_DELAY_MS = 350;

const MOD_KEY = isMac ? "Meta" : "Control";

/**
 * Tracks a deliberate HOLD of the platform's primary modifier and mirrors it
 * into `store.modKeyHeld` — StatusTab renders each tab's digit badge while
 * it's true (the tmux `display-panes` idea for mod+digit, ADR-063's set).
 *
 * Stuck-modifier protection is the load-bearing part: a keyup is never seen
 * when the user switches away WHILE holding (⌘Tab is the canonical case — it
 * is browser-reserved, we can't even observe it). window blur and
 * visibilitychange both clear the state, so badges can't wedge on.
 */
export function useModKeyHold(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (useStore.getState().modKeyHeld) {
        useStore.getState().setModKeyHeld(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === MOD_KEY) {
        // Auto-repeat fires keydown continuously while held — arm once.
        if (timer === null && !useStore.getState().modKeyHeld) {
          timer = setTimeout(() => {
            timer = null;
            useStore.getState().setModKeyHeld(true);
          }, MOD_HOLD_DELAY_MS);
        }
        return;
      }
      // A non-modifier key without the modifier held means the hold ended in
      // a way we missed (OS ate the keyup). With it held (⌘1, ⌘C) keep the
      // badges — the user may be walking through panes digit by digit.
      if (!(isMac ? e.metaKey : e.ctrlKey)) clear();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === MOD_KEY) clear();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      clear();
    };
  }, [enabled]);
}
