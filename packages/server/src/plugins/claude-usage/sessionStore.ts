/**
 * In-memory store for a Claude session cookie harvested from a spawned agent.
 *
 * Claude Code injects `CLAUDE_SESSION_COOKIE` (the claude.ai sessionKey) into
 * every process it spawns, including the hooks autonomOS attaches to each
 * session. A SessionStart hook relays that cookie here so the usage plugin can
 * work with no manual paste — even on a `make prod` server that was never
 * launched from a Claude Code context.
 *
 * The cookie is held ONLY in memory and never written to disk: re-harvested on
 * each agent spawn (so it stays fresh) and gone on restart (so a live
 * credential never lingers). This is intentionally more private than the
 * manual-paste path, which persists the key to settings.json in plaintext.
 */

let harvested: string | null = null;

/**
 * Store (or clear) the harvested session cookie. Trims; empty → cleared.
 * Returns true when the value actually changed, so the caller can invalidate
 * the usage cache only when needed.
 */
export function setHarvestedSessionKey(
  key: string | null | undefined,
): boolean {
  const next = key?.trim() || null;
  const changed = next !== harvested;
  harvested = next;
  return changed;
}

/** The harvested session cookie, or null if none has been relayed yet. */
export function getHarvestedSessionKey(): string | null {
  return harvested;
}
