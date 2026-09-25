// Copies the built dashboard (packages/dashboard/dist) into a known location
// under packages/server/src/ so that:
//   1. bun build --compile bundles it into the static binary (it picks up
//      files reachable from the entry point's directory tree).
//   2. The runtime path resolution in index.ts works identically in dev (tsx)
//      and in the compiled binary (import.meta.dirname maps to the same
//      relative location in both contexts).
//
// Idempotent — safe to re-run.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distProblem } from "../../../scripts/check-dashboard-dist.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDist = resolve(here, "../../dashboard/dist");
const target = resolve(here, "../src/_embedded_dashboard");

const indexHtml = resolve(dashboardDist, "index.html");
if (!existsSync(indexHtml)) {
  console.error(
    `[embed-dashboard] Dashboard not built — missing ${indexHtml}.\n` +
      `Run "bun --filter @autonomos/dashboard build" first.`,
  );
  process.exit(1);
}

// dist/ is copied verbatim into the binary: refuse anything that isn't the
// Vite build (e.g. stale tsc output — ~300 compiled src files + .d.ts).
const problem = distProblem(
  dashboardDist,
  resolve(here, "../../dashboard/public"),
);
if (problem) {
  console.error(`[embed-dashboard] ${problem}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(dashboardDist, target, { recursive: true });
console.log(`[embed-dashboard] Copied ${dashboardDist} → ${target}`);
