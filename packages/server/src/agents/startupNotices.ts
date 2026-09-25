/**
 * Scan a new agent's early PTY output for startup screens a provider declared
 * worth a notice (AgentProvider.startupNotices) — e.g. Gemini's folder-trust
 * dialog, which silently holds the agent at Ask until it's answered.
 *
 * Pure and chunk-boundary safe: output arrives in arbitrary chunks, so the
 * needle is matched against the accumulated (ANSI-stripped, despaced) text,
 * bounded to a tail long enough to hold any needle across a split.
 */

import { ANSI_RE, despace } from "../providers/ptyText.js";

export interface StartupNotice {
  needle: string;
  message: string;
}

/** How long a spawn is watched — startup screens render in the first seconds. */
export const STARTUP_NOTICE_WINDOW_MS = 60_000;
const TAIL_CHARS = 4_096;

/**
 * Returns `feed(chunk)`, which calls `onNotice(message)` once per notice the
 * first time its needle is seen, and reports whether every notice has fired
 * (the caller can stop feeding then).
 */
export function createStartupNoticeScanner(
  notices: readonly StartupNotice[],
  onNotice: (message: string) => void,
): (chunk: string) => boolean {
  const pending = notices.map((n) => ({ ...n, norm: despace(n.needle) }));
  let tail = "";
  return (chunk) => {
    if (pending.length === 0) return true;
    tail = (tail + despace(chunk.replace(ANSI_RE, ""))).slice(-TAIL_CHARS);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (tail.includes(pending[i].norm)) {
        onNotice(pending[i].message);
        pending.splice(i, 1);
      }
    }
    return pending.length === 0;
  };
}
