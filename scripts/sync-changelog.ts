// Promote the newest per-package changelog section (written by
// `changeset version`) into the single root CHANGELOG.md.
//
// Why: changesets writes one CHANGELOG.md per package. For a lockstep
// monorepo where all packages share one version, that's redundant noise.
// The product's canonical history is a single root CHANGELOG.md (what users
// browse + what becomes the GitHub Release body). This script runs right
// after `changeset version` (see the root "version" script) to keep the root
// changelog authoritative. Per-package CHANGELOGs are gitignored.
//
// Idempotent: re-running for an already-promoted version is a no-op.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const rootChangelog = resolve(repoRoot, "CHANGELOG.md");
// The app package is the representative source — fixed versioning means every
// package's CHANGELOG carries the same new section.
const pkgChangelog = resolve(repoRoot, "packages/app/CHANGELOG.md");
const pkgJson = resolve(repoRoot, "packages/app/package.json");
const ANCHOR = "<!-- changeset-insert-anchor -->";

const version = (
  JSON.parse(readFileSync(pkgJson, "utf-8")) as { version: string }
).version;

if (!existsSync(pkgChangelog)) {
  console.log(
    `[sync-changelog] no per-package changelog at ${pkgChangelog} — nothing to promote.`,
  );
  process.exit(0);
}

const root = readFileSync(rootChangelog, "utf-8");
if (root.includes(`## [${version}]`)) {
  console.log(
    `[sync-changelog] v${version} already present in root CHANGELOG — no-op.`,
  );
  process.exit(0);
}

// Extract the top version block from the per-package changelog. changesets
// writes sections as `## X.Y.Z\n\n### Minor Changes\n...` — grab from the
// first `## ` heading up to (but not including) the next one.
const pkg = readFileSync(pkgChangelog, "utf-8");
const blockMatch = pkg.match(/\n## [^\n]+\n([\s\S]*?)(?=\n## |\s*$)/);
if (!blockMatch) {
  console.log(
    "[sync-changelog] could not locate a version block in the per-package changelog — skipping.",
  );
  process.exit(0);
}
const body = blockMatch[1].trim();

const today = new Date().toISOString().slice(0, 10);
const section = `## [${version}] — ${today}\n\n${body}\n`;

const insertAt = root.indexOf(ANCHOR);
if (insertAt === -1) {
  console.error(
    `[sync-changelog] anchor "${ANCHOR}" not found in root CHANGELOG — refusing to guess placement.`,
  );
  process.exit(1);
}
const afterAnchor = insertAt + ANCHOR.length;
const updated = `${root.slice(0, afterAnchor)}\n\n${section}${root.slice(afterAnchor)}`;
writeFileSync(rootChangelog, updated);
console.log(`[sync-changelog] promoted v${version} into root CHANGELOG.md`);
