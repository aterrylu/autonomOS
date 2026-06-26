/** How long the copy-confirmation toast stays visible before auto-dismiss. */
export const COPY_TOAST_DISPLAY_MS = 2000;

/**
 * Claude Code re-emits OSC 52 several times while a selection stays live during
 * streaming (it re-syncs the selection to the clipboard). Suppress a repeat
 * toast for identical content within this window so the toast doesn't flicker
 * on every re-sync.
 */
export const COPY_TOAST_SUPPRESS_MS = 12000;

/**
 * Whether a copy event should be suppressed (no new toast) because it is a
 * streaming re-sync of the same content within the suppress window.
 *
 * Only successful copies are coalesced — a failed copy always surfaces, since
 * failures are rare and worth showing.
 */
export function shouldSuppressCopyToast(
  prev: { text: string | null; at: number },
  next: { text: string; ok: boolean; at: number },
  suppressMs = COPY_TOAST_SUPPRESS_MS,
): boolean {
  return next.ok && next.text === prev.text && next.at - prev.at < suppressMs;
}
