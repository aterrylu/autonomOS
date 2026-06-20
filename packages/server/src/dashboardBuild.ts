import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface DashboardBuild {
  /** Hashed main bundle filename (e.g. "index-DqFMNhch.js"), or null if absent. */
  build: string | null;
  /** ISO timestamp of the served index.html's mtime, or null. */
  builtAt: string | null;
}

/**
 * Extract the hashed main-bundle id from a Vite-built index.html. Vite emits
 * `<script type="module" ... src="/assets/index-<hash>.js">`; the hash changes
 * whenever the bundle content changes, so it's a stable "which build is this"
 * identifier — useful for spotting a server that's serving a stale dashboard.
 */
export function extractDashboardBuildId(html: string): string | null {
  const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

/**
 * Read the build identity of the dashboard the server is about to serve, for
 * staleness observability (startup log + /api/host). Best-effort so it never
 * crashes boot — but it LOGS on failure rather than returning a silent null:
 * the only caller invokes it after `existsSync` already confirmed index.html,
 * so a thrown error here is a real read/stat/permission problem (or a TOCTOU
 * delete), not a benign "no dashboard". Logging keeps the "?" in the startup
 * log from masking exactly the broken-serve case this guardrail exists to catch.
 */
export function readDashboardBuild(dist: string): DashboardBuild {
  try {
    const indexPath = resolve(dist, "index.html");
    const html = readFileSync(indexPath, "utf-8");
    return {
      build: extractDashboardBuildId(html),
      builtAt: statSync(indexPath).mtime.toISOString(),
    };
  } catch (err) {
    console.warn(
      `Could not read dashboard build identity from ${dist}/index.html ` +
        `(staleness check degraded): ${err instanceof Error ? err.message : err}`,
    );
    return { build: null, builtAt: null };
  }
}
