// Serving the built dashboard: hashed assets, other public files, and the SPA
// entry. Every response states its caching policy explicitly. Without one, the
// browser re-downloaded the whole ~1.5MB bundle, uncompressed, on every load:
// no Cache-Control, no validator, no Content-Encoding.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Env, Hono } from "hono";
import {
  type DashboardBuild,
  extractDashboardBuildId,
} from "./dashboardBuild.js";

/** Vite's content-hashed build output: its name changes whenever its bytes do,
 *  so the browser may keep it forever and never revalidate. */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/** Everything else (index.html, sw.js, the manifest, icons) must be
 *  revalidated on every load: index.html names the current asset hashes, so
 *  a cached copy would pin an old build after an upgrade. */
export const CACHE_REVALIDATE = "no-cache";

/** Types the build precompresses (keep in sync with dashboard/vite-plugins/precompress.ts). */
const COMPRESSIBLE =
  /\.(?:js|mjs|css|html|svg|json|webmanifest|txt)(?:\.(?:br|gz|zst))?$/;

interface Entry {
  key: string;
  html: string;
  etag: string;
  build: DashboardBuild;
}

export interface MountedDashboard {
  /** Identity of the index.html being served NOW. /api/host reports this, so
   *  the tab's staleness check compares against what a reload would get. */
  currentBuild(): DashboardBuild;
}

export function mountDashboard<E extends Env>(
  app: Hono<E>,
  dashboardDist: string,
): MountedDashboard {
  const indexPath = resolve(dashboardDist, "index.html");
  // Read once at boot, as before, so a missing build still fails fast at startup.
  let entry = readEntry(indexPath);
  let entryFailing = false;

  // The SPA entry is re-read when the file changes. The fallback used to serve
  // a boot-time snapshot, so after a rebuild without a restart, deep links
  // pointed at asset hashes that no longer exist.
  const currentEntry = (): Entry => {
    try {
      const st = statSync(indexPath);
      if (entryKey(st) !== entry.key) entry = readEntry(indexPath);
      if (entryFailing) {
        entryFailing = false;
        console.warn(`[dashboard] ${indexPath} is readable again`);
      }
    } catch (err) {
      // Keep serving the last good copy (a bundle swap can briefly remove the
      // dir), but say so: that copy names asset hashes that may be gone too,
      // which the browser shows as a blank page and nothing else would report.
      if (!entryFailing) {
        entryFailing = true;
        console.error(
          `[dashboard] ${indexPath} unreadable; serving the last good copy (its assets may be gone): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return entry;
  };

  const serveIndex = (c: Context<E>) => {
    const { html, etag } = currentEntry();
    // The shell may be requested with a token in the URL (a sign-in link, or a
    // legacy ?token= one): never store it, never send its URL as a Referer,
    // never render it inside another site's frame. On EVERY index response,
    // 304s and the SPA fallback included.
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("ETag", etag);
    // Weak comparison, as If-None-Match requires: a proxy that re-encodes the
    // response (e.g. nginx gzip) turns our tag into W/"…".
    const ifNoneMatch =
      c.req
        .header("If-None-Match")
        ?.split(",")
        .map((t) => t.trim().replace(/^W\//, "")) ?? [];
    if (ifNoneMatch.includes(etag) || ifNoneMatch.includes("*")) {
      return c.body(null, 304);
    }
    return c.html(html);
  };

  const serveFile = serveStatic<E>({
    root: dashboardDist,
    precompressed: true,
  });

  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);
  // serveStatic is wrapped, not configured via its onFound hook: onFound runs
  // AFTER the Response is built, so headers set there never reach the client.
  // The wrapper sets them on the returned Response itself.
  app.use("/*", async (c, next) => {
    let fellThrough = false;
    const res = await serveFile(c, async () => {
      fellThrough = true;
      await next();
    });
    if (fellThrough || !res) return;
    const path = c.req.path;
    res.headers.set(
      "Cache-Control",
      path.startsWith("/assets/") ? CACHE_IMMUTABLE : CACHE_REVALIDATE,
    );
    // On EVERY compressible response, identity included: without it a shared
    // cache could hand a stored uncompressed copy to a client that asked for
    // br, or a br copy to one that can't decode it.
    if (COMPRESSIBLE.test(path)) res.headers.set("Vary", "Accept-Encoding");
    return res;
  });
  // A missing hashed asset is a real 404, never the SPA entry: HTML served
  // for a module script fails with a MIME error and a blank page. This happens
  // when a tab from an old build asks for assets a rebuild deleted. `no-store`
  // so the miss is never cached under the asset URL.
  app.get("/assets/*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("Not found", 404);
  });
  // SPA fallback: client-side routes (deep links) get the entry document.
  app.get("*", serveIndex);

  return { currentBuild: () => currentEntry().build };
}

function entryKey(st: { ino: number; size: number; mtimeMs: number }): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

function readEntry(indexPath: string): Entry {
  const st = statSync(indexPath);
  const html = readFileSync(indexPath, "utf-8");
  return {
    key: entryKey(st),
    html,
    etag: `"${createHash("sha1").update(html).digest("base64url").slice(0, 22)}"`,
    build: {
      build: extractDashboardBuildId(html),
      builtAt: st.mtime.toISOString(),
    },
  };
}
