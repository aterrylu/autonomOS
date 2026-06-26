/**
 * In-memory store for the active Claude session cookie used by the usage plugin.
 *
 * The cookie (claude.ai `sessionKey`) is discovered automatically from the
 * user's running interactive Claude Code sessions (see {@link ./cookieScanner})
 * and/or relayed to the harvest endpoint (see {@link ./route}). Either way it is
 * held ONLY in memory and never written to disk: refreshed as the user's
 * sessions change (so it follows an account switch) and gone on restart (so a
 * live credential never lingers). This is intentionally more private than the
 * manual-paste path, which persists the key to settings.json in plaintext.
 */

let harvested: string | null = null;

/**
 * True when `key` matches the strict claude.ai session-cookie shape
 * (`sk-ant-sid…`, any version) and is short enough to ride safely inside a
 * Cookie request header. Rejects OAuth/API tokens (`sk-ant-oat…`),
 * header-injection characters (CR/LF/`;`), and stray noise.
 *
 * Shared by the harvest endpoint (push path) and the process-env scanner (pull
 * path) so a session key is validated identically no matter how it arrives —
 * there is exactly one copy of this security-relevant guard.
 */
export function isValidHarvestedKey(key: string): boolean {
  return /^sk-ant-sid[A-Za-z0-9._-]+$/.test(key) && key.length <= 512;
}

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
