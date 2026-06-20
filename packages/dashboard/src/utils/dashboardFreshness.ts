/**
 * Detect when the dashboard running in this tab is older than what the server
 * is now serving — e.g. a deploy happened while the tab stayed open, or (the
 * bug this guards against) the server is serving a stale bundle. The server
 * reports its served bundle id on /api/host; we compare it to the bundle this
 * tab actually loaded.
 */

/**
 * The hashed main-bundle id of the dashboard currently running in this tab,
 * read from the entry `<script src="/assets/index-<hash>.js">` the browser
 * loaded. Returns null if it can't be determined (e.g. the Vite dev server).
 */
export function getLoadedDashboardBuildId(
  doc: Document = document,
): string | null {
  const script = doc.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]',
  );
  const src = script?.getAttribute("src") ?? "";
  const m = src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

/**
 * Whether the loaded dashboard is stale relative to the server's served bundle.
 * True only when both ids are known and differ — unknown ids (dev server, older
 * server without the field) never report stale, so we don't cry wolf.
 */
export function isDashboardStale(
  loaded: string | null,
  served: string | null | undefined,
): boolean {
  return !!loaded && !!served && loaded !== served;
}
