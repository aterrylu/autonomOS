import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";
import { displayChord } from "./chord";
import { pushEscapeCloser } from "./escapeStack";
import { SHORTCUTS } from "./registry";

/**
 * The keyboard-shortcut cheatsheet (mod+/). Renders straight from the
 * registry, so it can never drift from the real bindings. Closes on backdrop
 * click, mod+/ again, or Escape (the registry's `help.close` entry — Escape
 * is only app-reserved while this overlay is open).
 */
export function ShortcutHelpOverlay() {
  const open = useStore((s) => s.shortcutHelpOpen);
  if (!open) return null;
  return <HelpDialog />;
}

/** Mounted only while open, so focus capture/restore ride mount/unmount. */
function HelpDialog() {
  const close = useStore((s) => s.closeShortcutHelp);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Back the aria-modal claim: move DOM focus INTO the dialog on open (else a
  // focused terminal behind it keeps receiving everything typed), and restore
  // it to the previously-focused element on close so the user's terminal
  // focus survives a mod+/ peek at the cheatsheet.
  useEffect(() => {
    const prev = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, []);

  // Escape-to-close rides the registry's ui.dismiss entry via the escape
  // stack (ADR-065) — mounted-open means dismissible.
  useEffect(() => pushEscapeCloser(useStore.getState().closeShortcutHelp), []);

  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; keyboard close is the registry's help.close (Escape)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close is the registry's help.close (Escape)
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      // Close only for a click that landed on the backdrop ITSELF — clicks
      // inside the dialog bubble up to here with a different target.
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="w-96 max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg p-5 shadow-xl outline-none"
        style={{
          background: page.bg,
          color: page.fg,
          border: `1px solid ${page.border}`,
        }}
      >
        <h2 className="text-sm font-semibold mb-4">Keyboard shortcuts</h2>
        {categories.map((category) => (
          <div key={category} className="mb-4 last:mb-0">
            <h3
              className="text-xs font-medium uppercase tracking-wide mb-2"
              style={{ color: page.statusFg }}
            >
              {category}
            </h3>
            <ul className="space-y-1.5">
              {SHORTCUTS.filter((s) => s.category === category).map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between text-xs"
                >
                  <span>{s.description}</span>
                  <kbd
                    className="rounded px-1.5 py-0.5 font-mono"
                    style={{
                      background: page.border,
                      color: page.fg,
                    }}
                  >
                    {displayChord(s.chord)}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
