/**
 * Brief feedback for a user action that has no pane of its own to show it in —
 * "Restarted X", "Restart failed: <why>", a resume that can't happen. Before
 * this, those outcomes went only to the browser console, so a failed Restart
 * looked like it "literally did nothing".
 *
 * The same pill as CopyToast (theme tokens, so both themes follow), fixed at
 * the bottom centre of the app. Auto-dismiss is owned by the store
 * (showActionToast); this component is purely presentational.
 */

import { useStore } from "../store";
// Registers the shared `copy-toast-in` keyframes (a module side effect), even
// when no terminal pane — and so no CopyToast — has mounted yet.
import "./CopyToast";

export function ActionToast() {
  const toast = useStore((s) => s.actionToast);
  if (!toast) return null;
  return (
    // <output> = implicit role="status" + polite live region, so the outcome
    // is announced to screen readers too.
    <output
      key={toast.id}
      data-action-toast={toast.ok ? "ok" : "error"}
      className="pointer-events-none fixed bottom-10 left-1/2 z-50 flex max-w-[min(90vw,36rem)] -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-lg"
      style={{ animation: "copy-toast-in 140ms ease-out" }}
    >
      <span
        aria-hidden="true"
        style={{ color: toast.ok ? "#73c991" : "#ea6c73" }}
      >
        {toast.ok ? "✓" : "⚠"}
      </span>
      <span className="min-w-0 break-words">{toast.text}</span>
    </output>
  );
}
