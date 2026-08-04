// Deduplicate link activations — multiple providers (UrlLinkProvider + xterm
// built-in OSC 8 linkHandler) can fire for the same Ctrl+Click, opening two
// browser tabs. Both call sites must route through this function.
let lastOpenedUrl = "";
let lastOpenedAt = 0;
const LINK_DEDUP_MS = 500;

// Only open these schemes. A terminal hyperlink is attacker-influenceable —
// agent output can emit an OSC 8 link (`ESC ]8;;<uri> … ESC ]8;;`) with any
// scheme and benign-looking link text. Browsers block `javascript:`/`data:`
// for a top-level window.open, but an explicit allowlist is defense-in-depth
// and also refuses `file:`, `vbscript:`, custom app-protocol handlers, etc.
// This is the single chokepoint both link paths (OSC 8 linkHandler + the
// regex UrlLinkProvider) route through, so the check lives here once.
const ALLOWED_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function deduplicatedOpen(url: string): void {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    // Not an absolute, parseable URL — refuse rather than hand a garbage or
    // relative value to window.open.
    console.warn(`Refusing to open non-URL terminal link: ${url}`);
    return;
  }
  if (!ALLOWED_LINK_SCHEMES.has(scheme)) {
    console.warn(`Refusing to open terminal link with scheme "${scheme}"`);
    return;
  }

  const now = Date.now();
  if (url === lastOpenedUrl && now - lastOpenedAt < LINK_DEDUP_MS) return;
  lastOpenedUrl = url;
  lastOpenedAt = now;
  window.open(url, "_blank", "noopener");
}
