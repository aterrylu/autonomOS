/**
 * Build-time security floors (V12b, ADR-137). `make build`, which every
 * upgrade path runs, calls this right after `bun install`:
 *
 *   tsx scripts/check-security-floors.ts   # exit 1 + explanation if still unmet
 *
 * A plain `bun install` keeps a nested copy the new lockfile no longer lists,
 * so a security bump can miss the package that actually loads the dependency
 * (measured: an upgraded clone still served ws 8.19 through @hono/node-ws).
 * When the installed tree misses a floor, this relinks it ONCE with
 * `bun install --force --frozen-lockfile` and checks again. It only relinks
 * when needed: --force contacts the registry even with a warm cache, so doing
 * it every time would hang an offline build of a healthy tree.
 *
 * A relink that fails (offline with a cold cache) leaves the existing tree in
 * place (measured), and the build fails with the fix to run.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkInstalledFloors,
  ensureSecurityFloors,
  formatFloorViolations,
  RELINK_COMMAND,
} from "../packages/server/src/securityFloors.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** bun retries an unreachable registry for minutes; bound the relink. */
const RELINK_TIMEOUT_MS = 10 * 60_000;

const left = ensureSecurityFloors({
  check: () => checkInstalledFloors(join(repo, "packages", "server")),
  relink: () => {
    const [cmd, ...args] = RELINK_COMMAND;
    const r = spawnSync(process.env.BUN || cmd, args, {
      cwd: repo,
      stdio: "inherit",
      timeout: RELINK_TIMEOUT_MS,
    });
    if (r.error) return { ok: false, detail: r.error.message };
    if (r.status !== 0) return { ok: false, detail: `exit ${r.status}` };
    return { ok: true, detail: "" };
  },
  log: (line) => console.error(line),
});

if (left?.length) {
  console.error(formatFloorViolations(left, repo));
  process.exit(1);
}
