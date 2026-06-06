// Pure node-only helpers extracted from server-supervisor.ts so they can
// be unit-tested without loading `electron`. Production code paths in
// server-supervisor.ts re-export these for callers (main.ts).

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Best-effort cleanup of leaked ephemeral dirs from prior Desktop crashes.
 *  Scans `root` (default: os.tmpdir()) for `autonomos-ephemeral-*` entries
 *  and removes those older than `ageThresholdMs` (default: 1 hour). macOS
 *  auto-cleans $TMPDIR every ~3 days, but eager cleanup at boot bounds
 *  the steady-state count. The root/threshold parameters are seams for
 *  testing — production callers should pass no arguments. */
export function cleanupLeakedEphemeralDirs(
  root: string = tmpdir(),
  ageThresholdMs: number = 60 * 60 * 1000,
): void {
  try {
    const entries = readdirSync(root);
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith("autonomos-ephemeral-")) continue;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        if (now - stat.mtimeMs > ageThresholdMs) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // Ignore — best-effort.
      }
    }
  } catch {
    // Ignore — root unreachable is non-fatal.
  }
}
