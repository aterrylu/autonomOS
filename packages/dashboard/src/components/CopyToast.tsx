/**
 * Transient confirmation that text was auto-copied to the clipboard via OSC 52.
 *
 * Claude Code's auto-copy-on-select is otherwise invisible — especially on a
 * remote (plain-HTTP) deployment where the copy goes through the execCommand
 * fallback. This floats a brief pill over the terminal pane so the user knows
 * something landed on their clipboard. Coalescing/auto-dismiss is owned by
 * useTerminal; this component is purely presentational.
 */

export interface CopyToastState {
  /** Bumped on each show so React remounts the pill and re-runs the animation. */
  id: number;
  /** Number of characters (code points) copied. */
  chars: number;
  /** Whether the copy succeeded; false renders the failure variant. */
  ok: boolean;
}

const STYLE_ID = "copy-toast-keyframes";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    @keyframes copy-toast-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(el);
}

interface CopyToastProps {
  toast: CopyToastState | null;
}

export function CopyToast({ toast }: CopyToastProps) {
  if (!toast) return null;
  const { id, chars, ok } = toast;
  return (
    // <output> carries an implicit role="status" + polite live region, so the
    // copy confirmation is announced to screen readers without an explicit role.
    <output
      // key remounts the element each time so the entrance animation replays.
      key={id}
      // bottom-12 (not bottom-3) so the toast stacks above the persistent
      // UsageQueueButton, which owns the bottom-right corner.
      className="pointer-events-none absolute right-3 bottom-12 z-10 flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-lg"
      style={{ animation: "copy-toast-in 140ms ease-out" }}
    >
      <span aria-hidden="true" style={{ color: ok ? "#73c991" : "#ea6c73" }}>
        {ok ? "✓" : "⚠"}
      </span>
      <span>
        {ok
          ? `Copied ${chars.toLocaleString()} char${chars === 1 ? "" : "s"}`
          : "Copy failed"}
      </span>
    </output>
  );
}
