// Extract the current version's section from the root CHANGELOG.md and print
// it to stdout. The release workflow pipes this into the GitHub Release body
// so the release notes are exactly the curated changelog — not a raw commit
// dump.
//
// Usage: bun scripts/release-notes.ts [version]
//   version defaults to packages/server/package.json's version.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf-8");

const version =
  process.argv[2] ??
  (
    JSON.parse(
      readFileSync(resolve(repoRoot, "packages/server/package.json"), "utf-8"),
    ) as { version: string }
  ).version;

// Section headings look like `## [X.Y.Z] — 2026-06-06`. Grab from this
// version's heading up to the next `## ` heading (or EOF).
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`\\n## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
const match = changelog.match(re);

if (!match) {
  console.error(`[release-notes] no CHANGELOG section found for v${version}`);
  process.exit(1);
}

process.stdout.write(match[1].trim());
process.stdout.write("\n");
