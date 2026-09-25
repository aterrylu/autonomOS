/**
 * Guard: the served dashboard `dist/` must contain ONLY what Vite builds.
 *
 * `dist/` is served publicly by the server and copied verbatim into the binary
 * (packages/server/build/embed-dashboard.ts). The dashboard's `tsc --build`
 * used to emit into it (outDir "dist"), dropping ~300 files — compiled
 * `store.js`, `App.js`, `.d.ts` + maps — that were then publicly reachable and
 * embedded. The tsconfig now emits to `.tsbuild/`; this check keeps anything
 * else from creeping back in.
 *
 * Allowed at the top level of dist: `index.html`, `assets/`, and exactly the
 * entries of `packages/dashboard/public/` (Vite copies those verbatim). No
 * `.d.ts`/`.d.ts.map` anywhere.
 *
 *   tsx scripts/check-dashboard-dist.ts   # exit 1 + list when dist is polluted
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DASHBOARD_DIST = join(repo, "packages/dashboard/dist");
export const DASHBOARD_PUBLIC = join(repo, "packages/dashboard/public");

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Paths in `dist` (relative) that a Vite build does not produce. Empty when
 *  clean, or when dist doesn't exist (nothing built = nothing to serve). */
export function unexpectedDistEntries(dist: string, publicDir: string): string[] {
  if (!existsSync(dist)) return [];
  const allowed = new Set([
    "index.html",
    "assets",
    ...(existsSync(publicDir) ? readdirSync(publicDir) : []),
  ]);
  const bad: string[] = [];
  for (const name of readdirSync(dist)) {
    // The build precompresses files ≥1KB (dashboard/vite-plugins/precompress.ts),
    // so an allowed file may have a .br/.gz sibling next to it.
    if (!allowed.has(name.replace(/\.(?:br|gz|zst)$/, ""))) bad.push(name);
  }
  // Declarations anywhere (incl. under assets/) are tsc output by definition.
  for (const file of walk(dist)) {
    const rel = relative(dist, file);
    if (/\.d\.ts(\.map)?$/.test(rel) && !bad.includes(rel.split("/")[0])) {
      bad.push(rel);
    }
  }
  return bad.sort();
}

/** Human-readable failure, or null when clean. */
export function distProblem(dist: string, publicDir: string): string | null {
  const bad = unexpectedDistEntries(dist, publicDir);
  if (bad.length === 0) return null;
  const shown = bad.slice(0, 12).join(", ");
  const more = bad.length > 12 ? ` (+${bad.length - 12} more)` : "";
  return (
    `[check-dashboard-dist] ${dist} contains files a Vite build does not produce: ${shown}${more}.\n` +
    "  dist/ is served publicly and embedded in the binary, so it must hold only the Vite output.\n" +
    "  Usually stale tsc output from before the dashboard emitted to .tsbuild/: rebuild the dashboard\n" +
    "  (`bun --filter @autonomos/dashboard build` — Vite empties dist/ first)."
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problem = distProblem(DASHBOARD_DIST, DASHBOARD_PUBLIC);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log("✓ packages/dashboard/dist: only Vite output");
}
