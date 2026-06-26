// Single source of truth for "what version is this server?" Used by the PID
// file, /api/system/version, and the upgrade flow.
//
// Resolves a package.json reachable from import.meta.dirname:
//   - When bundled (dist/<platform>/index.js): package.json sits next to it
//     (the build script copies it in).
//   - When running from source via tsx (src/run.ts): ../package.json.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function getServerVersion(): string {
  const candidates = [
    // Bundled layout: bundle dir contains the JS + its package.json
    resolve(import.meta.dirname, "package.json"),
    // Source layout: src/ → packages/server/package.json
    resolve(import.meta.dirname, "../package.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "unknown";
}
