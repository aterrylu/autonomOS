// Deduplicate link activations — multiple providers (UrlLinkProvider + xterm
// built-in OSC 8 linkHandler) can fire for the same Ctrl+Click, opening two
// browser tabs. Both call sites must route through this function.
let lastOpenedUrl = "";
let lastOpenedAt = 0;
const LINK_DEDUP_MS = 500;

export function deduplicatedOpen(url: string): void {
  const now = Date.now();
  if (url === lastOpenedUrl && now - lastOpenedAt < LINK_DEDUP_MS) return;
  lastOpenedUrl = url;
  lastOpenedAt = now;
  window.open(url, "_blank", "noopener");
}
