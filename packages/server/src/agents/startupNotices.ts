/**
 * Scan a new agent's early PTY output for startup screens a provider declared
 * worth a notice (AgentProvider.startupNotices) — e.g. Gemini's folder-trust
 * dialog, which silently holds the agent at Ask until it's answered.
 *
 * Pure and chunk-boundary safe: output arrives in arbitrary chunks, which can
 * split an escape sequence, so the needle is matched against the accumulated
 * RAW tail after stripping ANSI and whitespace from it as a whole.
 */

import { ANSI_RE, despace } from "../providers/ptyText.js";

export interface StartupNotice {
  needle: string;
  message: string;
}

/** How long a spawn is watched — startup screens render in the first seconds. */
export const STARTUP_NOTICE_WINDOW_MS = 60_000;
/** Raw bytes kept across chunks: escapes are dense in TUI output, so this is
 *  generous enough to hold any needle plus the styling around it. */
const RAW_TAIL_CHARS = 16_384;

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
  // Keep the RAW tail and strip escapes from the joined text: a PTY read can
  // end mid-escape (\e[1 | C), and stripping each chunk alone leaves the
  // fragments behind, which break a needle that spans them.
  let raw = "";
  return (chunk) => {
    if (pending.length === 0) return true;
    raw = (raw + chunk).slice(-RAW_TAIL_CHARS);
    const tail = despace(raw.replace(ANSI_RE, ""));
    for (let i = pending.length - 1; i >= 0; i--) {
      if (tail.includes(pending[i].norm)) {
        onNotice(pending[i].message);
        pending.splice(i, 1);
      }
    }
    return pending.length === 0;
  };
}
