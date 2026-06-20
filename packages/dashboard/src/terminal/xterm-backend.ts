import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { deduplicatedOpen } from "../utils/deduplicatedOpen";
import { hasPrimaryModifier } from "../utils/platform";
import type { TerminalBackend, TerminalOptions } from "./types";

/**
 * Copy text to the system clipboard, with a fallback for insecure contexts.
 *
 * `navigator.clipboard` only exists in a *secure context* — HTTPS, or the
 * `localhost`/`127.0.0.1` exception that browsers grant even over plain HTTP.
 * When autonomOS is served over plain HTTP from a remote host (a LAN IP or a
 * hostname), the page is NOT a secure context and `navigator.clipboard` is
 * `undefined`. The bare property access `navigator.clipboard.writeText` would
 * then throw a `TypeError` synchronously, which is exactly why remote auto-copy
 * silently failed: Claude Code's OSC 52 bytes arrived intact, but the write
 * threw before anything reached the clipboard.
 *
 * We therefore probe for the API and fall back to the legacy
 * `document.execCommand("copy")` path, which is NOT secure-context-gated. That
 * fallback relies on transient user activation, but OSC 52 copies are emitted
 * by Claude Code only milliseconds after the user's mouse selection, so the
 * activation window (~5s) is typically still open and the copy succeeds without
 * an explicit click. If BOTH mechanisms fail (e.g. activation has expired) the
 * copy no-ops and logs a single `console.warn` breadcrumb — a future one-click
 * Copy affordance can cover that tail with real UX. We deliberately do not
 * surface the per-copy failure to the user here.
 *
 * Returns a promise resolving to whether the copy ultimately succeeded, so
 * callers can surface UI feedback (e.g. a "Copied" toast / "Copy failed").
 * Exported for unit testing the secure/insecure branches in isolation.
 */
export function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    // Secure context (HTTPS or localhost). If the write is rejected anyway
    // (e.g. transient activation expired), fall back to the legacy path.
    return clipboard.writeText(text).then(
      () => true,
      (err) => {
        const ok = execCommandCopy(text);
        if (!ok) {
          console.warn(
            "OSC 52 copy failed: Clipboard API rejected and execCommand fallback also failed:",
            err,
          );
        }
        return ok;
      },
    );
  }
  // Insecure context (plain HTTP on a remote host): no Clipboard API at all.
  const ok = execCommandCopy(text);
  if (!ok) {
    console.warn(
      "OSC 52 copy failed: insecure context and execCommand fallback returned false",
    );
  }
  return Promise.resolve(ok);
}

/**
 * Legacy clipboard write via a transient off-screen `<textarea>` + the
 * deprecated `document.execCommand("copy")`. Deprecated but still broadly
 * supported, and — unlike the Clipboard API — it works in insecure contexts.
 * Restores the previously focused element so the terminal keeps keyboard focus.
 *
 * Returns whether the copy succeeded so the caller can surface a breadcrumb
 * when both this and the Clipboard API have failed.
 */
function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Keep it out of the layout/viewport and non-interactive.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "none";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // execCommand can throw in some browsers; treat as a failed copy.
    copied = false;
  }
  textarea.remove();
  previouslyFocused?.focus?.();
  return copied;
}

export function createXtermBackend(
  options: TerminalOptions,
  onClipboardCopy?: (info: { text: string; ok: boolean }) => void,
): TerminalBackend {
  const terminal = new Terminal({
    ...options,
    macOptionIsMeta: true,
    allowProposedApi: true,
    scrollSensitivity: 3,
    linkHandler: {
      activate(event: MouseEvent, uri: string) {
        if (hasPrimaryModifier(event)) {
          deduplicatedOpen(uri);
        }
      },
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const unicodeAddon = new Unicode11Addon();
  terminal.loadAddon(unicodeAddon);
  terminal.unicode.activeVersion = "11";

  // xterm.js 6.0.0 has a bug where its built-in DECRQM (mode report) handler
  // throws `ReferenceError: t is not defined` on `CSI $ p` / `CSI ? $ p` —
  // Ink (used by Claude Code) emits `CSI ? 2026 $ p` to probe synchronized-output
  // support, which freezes the terminal mid-write. Shadow both handlers with a
  // safe no-op before the built-in runs.
  terminal.parser.registerCsiHandler(
    { intermediates: "$", final: "p" },
    () => true,
  );
  terminal.parser.registerCsiHandler(
    { prefix: "?", intermediates: "$", final: "p" },
    () => true,
  );

  // OSC 52 writes to the system clipboard. Read requests (`?`) are dropped so
  // a remote process can't exfiltrate the user's clipboard. The clipboard write
  // itself is delegated to copyTextToClipboard, which handles insecure contexts
  // (plain HTTP on a remote host) where navigator.clipboard is undefined.
  terminal.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(";");
    if (semi === -1) return true;
    const payload = data.slice(semi + 1);
    if (payload === "?") return true;
    let text: string;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch (err) {
      console.warn("OSC 52 decode failed:", err);
      return true;
    }
    // Report the outcome so the UI can confirm the copy (auto-copy-on-select is
    // otherwise invisible). The write may resolve async (Clipboard API path).
    // copyTextToClipboard is designed never to reject; the .catch is a
    // defensive net so a future regression surfaces "Copy failed" rather than
    // an unhandled rejection swallowed inside this OSC parser callback.
    void copyTextToClipboard(text)
      .then((ok) => {
        onClipboardCopy?.({ text, ok });
      })
      .catch(() => {
        onClipboardCopy?.({ text, ok: false });
      });
    return true;
  });

  return {
    terminal: terminal as unknown as TerminalBackend["terminal"],
    fitAddon,
    createWebglAddon: () => new WebglAddon(),
  };
}
