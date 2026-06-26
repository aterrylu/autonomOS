// Build the single root CHANGELOG.md section for the just-versioned release by
// merging EVERY per-package changelog, rendered as one concise line per PR.
//
// Why this exists (load-bearing assumption — read before editing):
//   `changeset version` writes one CHANGELOG.md per package, and
//   `@changesets/changelog-github` files each changeset's entry ONLY into the
//   CHANGELOG of the package(s) named in that changeset's frontmatter. Our
//   `fixed` group (.changeset/config.json) keeps all packages on the SAME
//   VERSION NUMBER, but it does NOT replicate entries across packages. So a
//   server-only / dashboard-only / core-only changeset never appears in
//   packages/app/CHANGELOG.md. Promoting from a single representative package
//   (the old behavior) therefore silently dropped every entry that didn't list
//   @autonomos/app — which is why v0.3.0's release body showed 1 of ~21 changes.
//   The fix: iterate over ALL packages/*/CHANGELOG.md, collect every PR, and
//   dedup across them. Do NOT revert to a single-package source.
//
// Output format (Terry's preference): one line per unique PR, NOT the full
// changeset body —
//   - [#NNN](https://github.com/aterrylu/autonomOS/pull/NNN) `<7-sha>` — <PR title>
// The PR title comes from the squash-merge commit subject (`git log %s` →
// strip the trailing ` (#NNN)`), which is cheap, deterministic, and needs no
// network. Per-package CHANGELOGs stay verbose for posterity; only the root
// CHANGELOG (and thus the GitHub Release body) is condensed.
//
// Runs right after `changeset version` (see the root "version" script).
// Idempotent: re-running for an already-promoted version is a no-op.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "aterrylu/autonomOS";
const ANCHOR = "<!-- changeset-insert-anchor -->";

export type Severity = "Major" | "Minor" | "Patch";
const SEVERITY_ORDER: Severity[] = ["Major", "Minor", "Patch"];
const SEVERITY_RANK: Record<Severity, number> = { Major: 3, Minor: 2, Patch: 1 };

export interface ReleaseEntry {
  /** PR number, or null when changelog-github couldn't map the commit to a PR. */
  pr: number | null;
  /** 7-char commit sha, or null for a (rare) entry with no commit link. */
  sha: string | null;
  /** The changeset body — fallback title when no sha is available to query git. */
  body: string;
  severity: Severity;
}

/**
 * Extract the version block for `version` from one per-package CHANGELOG.
 * changesets writes the newest section at the top as `## X.Y.Z` (plain — no
 * brackets/date; the bracketed+dated heading is a root-CHANGELOG convention we
 * add below). Tolerates an optional `[...]` and trailing text on the heading.
 * Returns the block body (text between this heading and the next `## `), or
 * null if this version isn't present.
 */
export function extractVersionBlock(
  changelog: string,
  version: string,
): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `(?:^|\n)` so a heading at the very start of the file still matches.
  const re = new RegExp(
    `(?:^|\\n)## \\[?${escaped}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\s*$)`,
  );
  const m = changelog.replace(/\r\n/g, "\n").match(re);
  return m ? m[1] : null;
}

/**
 * Parse changelog-github entries out of a version block, tagging each with the
 * severity of the `### X Changes` subsection it sits under. The first line of a
 * changelog-github bullet looks like:
 *   - [#NNN](pull/NNN) [`sha`](commit/sha) Thanks [@user](..)! - body
 * PR and sha are optional (a manual/unresolved changeset may omit either); the
 * body is captured as a fallback title. We never drop a bullet — dropping is the
 * exact bug this script fixes.
 */
export function parseEntries(block: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  let current: Severity | null = null;
  for (const line of block.split("\n")) {
    const head = line.match(/^###\s+(Major|Minor|Patch)\s+Changes\s*$/);
    if (head) {
      current = head[1] as Severity;
      continue;
    }
    if (!current) continue;
    // An entry is a bullet that OPENS with changelog-github's signature: a PR
    // link `- [#NNN]` or, when no PR was resolved, a commit link `` - [`sha`] ``.
    // Requiring the leading token (not just `- `) means a multi-paragraph body's
    // wrapped prose or a markdown sub-bullet can't be misread as a phantom entry
    // — and a real entry the regex can't see is caught by the parsed-vs-consumed
    // count check in main(), never silently dropped.
    if (!/^-\s+\[(?:#\d+|`[0-9a-f]{7,40}`)\]/i.test(line)) continue;

    const pr = line.match(/\[#(\d+)\]/);
    const sha = line.match(/\[`([0-9a-f]{7,40})`\]/i);
    // Body = text after the changelog-github "...! - " marker, else the bullet
    // text itself. Only used when no sha is available to query git.
    const afterMarker = line.split(/!\s+-\s+/);
    const body =
      afterMarker.length > 1
        ? afterMarker.slice(1).join("! - ").trim()
        : line.replace(/^-\s+/, "").trim();

    entries.push({
      pr: pr ? Number(pr[1]) : null,
      sha: sha ? sha[1].slice(0, 7) : null,
      body,
      severity: current,
    });
  }
  return entries;
}

/**
 * Collapse entries that refer to the same PR (a PR with multiple changesets, or
 * a changeset listing several packages, appears once per package CHANGELOG).
 * Dedup key cascades PR → sha → body. On collision, keep the HIGHEST severity
 * (a change that's minor for any consumer is at least minor for the release).
 */
export function dedupeEntries(entries: ReleaseEntry[]): ReleaseEntry[] {
  // Dedup key cascades PR → sha → body so the same change collapses regardless
  // of which identifier survived parsing.
  function dedupeKey(e: ReleaseEntry): string {
    if (e.pr != null) return `pr:${e.pr}`;
    if (e.sha != null) return `sha:${e.sha}`;
    return `body:${e.body}`;
  }

  const byKey = new Map<string, ReleaseEntry>();
  for (const e of entries) {
    const key = dedupeKey(e);
    const existing = byKey.get(key);
    if (
      !existing ||
      SEVERITY_RANK[e.severity] > SEVERITY_RANK[existing.severity]
    ) {
      byKey.set(key, e);
    }
  }
  return [...byKey.values()];
}

/**
 * Render the merged, deduped entries into a changelog section: severity
 * subsections in Major→Minor→Patch order, entries within each sorted by PR
 * number ascending (sha/body-only entries sort last) for deterministic,
 * snapshot-stable output. `resolveTitle` maps a sha to the PR title (injected
 * so this stays pure + unit-testable without git); on miss we fall back to the
 * changeset body. Returns "" when there are no entries.
 */
export function renderSection(
  entries: ReleaseEntry[],
  resolveTitle: (sha: string) => string,
): string {
  const deduped = dedupeEntries(entries);
  const parts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const inSection = deduped
      .filter((e) => e.severity === sev)
      .sort(
        (a, b) =>
          (a.pr ?? Number.POSITIVE_INFINITY) -
            (b.pr ?? Number.POSITIVE_INFINITY) ||
          (a.sha ?? "").localeCompare(b.sha ?? ""),
      );
    if (inSection.length === 0) continue;

    const lines = inSection.map((e) => {
      const title = (e.sha && resolveTitle(e.sha)) || e.body || "(no description)";
      let link: string;
      if (e.pr != null && e.sha) {
        link = `[#${e.pr}](https://github.com/${REPO}/pull/${e.pr}) \`${e.sha}\``;
      } else if (e.pr != null) {
        link = `[#${e.pr}](https://github.com/${REPO}/pull/${e.pr})`;
      } else if (e.sha) {
        link = `\`${e.sha}\``;
      } else {
        link = "";
      }
      return link ? `- ${link} — ${title}` : `- ${title}`;
    });
    parts.push(`### ${sev} Changes\n\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Derive a PR title from a squash-merge commit subject by stripping the
 * trailing ` (#NNN)` that GitHub appends: `feat(x): y (#123)` → `feat(x): y`.
 * Pure + exported so the extraction is unit-testable without git.
 */
export function titleFromSubject(subject: string): string {
  return subject.replace(/\s*\(#\d+\)\s*$/, "").trim();
}

/**
 * Whether a changeset file declares at least one package bump (vs. an
 * `--empty` changeset, whose frontmatter has no `"pkg": bump` lines). Only
 * non-empty changesets produce changelog entries, so empty ones must be
 * excluded from the parsed-vs-consumed reconciliation. Pure + exported.
 */
export function isNonEmptyChangeset(content: string): boolean {
  const fm = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fm ? fm[1] : "";
  return /["'][^"']+["']\s*:\s*(?:patch|minor|major)/.test(frontmatter);
}

/**
 * Guardrail decision (pure): should we accept an empty merged section?
 * `consumed` = count of NON-EMPTY changesets consumed this run.
 *   - non-empty            → "ok"
 *   - empty + consumed > 0 → "fail" (the regression: real changesets were
 *                            consumed this run but nothing made it into the section)
 *   - empty + consumed < 0 → "warn" (couldn't detect consumption — loud, not fatal)
 *   - empty + consumed = 0 → "ok"   (legitimately empty: no real changesets consumed)
 */
export function guardDecision(
  merged: string,
  consumed: number,
): "ok" | "warn" | "fail" {
  if (merged.trim().length > 0) return "ok";
  if (consumed > 0) return "fail";
  if (consumed < 0) return "warn";
  return "ok";
}

// ── impure shell (only runs as a script, never on import) ───────────────────

/** PR title from the squash-merge commit subject: `<title> (#NNN)` → `<title>`. */
function gitTitle(repoRoot: string, sha: string): string {
  try {
    const subject = execFileSync("git", ["log", "-1", "--format=%s", sha], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    return titleFromSubject(subject);
  } catch (err) {
    // A sha from a real changelog entry that git can't resolve is anomalous
    // (shallow clone, rewritten history) — surface it; caller falls back to body.
    console.warn(
      `[sync-changelog] could not resolve commit ${sha}: ${(err as Error).message}`,
    );
    return "";
  }
}

/**
 * Count the NON-EMPTY `.changeset/*.md` files consumed this run. `changeset
 * version` deletes consumed changesets, and this script runs right after it
 * (before the changesets action commits), so the deletions show in
 * `git status`. Each deleted file's pre-deletion content is read from HEAD to
 * skip `--empty` changesets (which produce no changelog entry and would
 * otherwise inflate the count). Returns -1 if git is unavailable so the
 * guardrail warns rather than failing. Conservative: a changeset whose content
 * can't be read is counted as non-empty (never undercount → never hide a drop).
 */
function consumedChangesetCount(repoRoot: string): number {
  try {
    const out = execFileSync(
      "git",
      ["status", "--porcelain", "--", ".changeset"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    const deleted = out
      .split("\n")
      .filter(Boolean)
      .filter((l) => {
        const status = l.slice(0, 2);
        const path = l.slice(3).trim();
        return (
          status.includes("D") &&
          path.startsWith(".changeset/") &&
          path.endsWith(".md") &&
          !path.endsWith("README.md")
        );
      })
      .map((l) => l.slice(3).trim());

    let count = 0;
    for (const path of deleted) {
      try {
        const content = execFileSync("git", ["show", `HEAD:${path}`], {
          cwd: repoRoot,
          encoding: "utf-8",
        });
        if (isNonEmptyChangeset(content)) count++;
      } catch {
        count++; // can't read → assume non-empty (don't undercount)
      }
    }
    return count;
  } catch (err) {
    console.warn(
      `[sync-changelog] could not detect consumed changesets: ${(err as Error).message}`,
    );
    return -1;
  }
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const rootChangelog = resolve(repoRoot, "CHANGELOG.md");
  const pkgJson = resolve(repoRoot, "packages/app/package.json");

  const version = (
    JSON.parse(readFileSync(pkgJson, "utf-8")) as { version: string }
  ).version;

  const root = readFileSync(rootChangelog, "utf-8");
  if (root.includes(`## [${version}]`)) {
    console.log(
      `[sync-changelog] v${version} already present in root CHANGELOG — no-op.`,
    );
    return;
  }

  // Merge every per-package CHANGELOG (the core fix — NOT just packages/app).
  // Per-package contribution is logged so a partial drop is visible in CI output
  // instead of being silently absent (the original bug's signature).
  const packagesDir = resolve(repoRoot, "packages");
  const entries: ReleaseEntry[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const changelog = resolve(packagesDir, pkg, "CHANGELOG.md");
    if (!existsSync(changelog)) continue;
    const text = readFileSync(changelog, "utf-8").replace(/\r\n/g, "\n");
    const block = extractVersionBlock(text, version);
    if (!block) {
      console.log(`[sync-changelog]   ${pkg}: no v${version} block`);
      continue;
    }
    const parsed = parseEntries(block);
    console.log(`[sync-changelog]   ${pkg}: ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"}`);
    entries.push(...parsed);
  }

  const merged = renderSection(entries, (sha) => gitTitle(repoRoot, sha));

  // Reconcile: every non-empty consumed changeset writes to >=1 package
  // CHANGELOG, and we read them all, so parsed entries must be >= consumed.
  // Fewer means entries were lost (parse miss / unread package) — the exact
  // partial-drop class that shipped v0.3.0 (1 of 21). Warn loudly; don't fail,
  // because consumption detection is heuristic (git-dependent).
  const consumed = consumedChangesetCount(repoRoot);
  if (consumed > 0 && entries.length < consumed) {
    console.warn(
      `[sync-changelog] v${version}: parsed ${entries.length} entr${entries.length === 1 ? "y" : "ies"} ` +
        `but ${consumed} non-empty changeset(s) were consumed — some changes may be ` +
        `MISSING from the release. Check packages/*/CHANGELOG.md.`,
    );
  }

  const decision = guardDecision(merged, consumed);
  if (decision === "fail") {
    console.error(
      `[sync-changelog] v${version}: changesets were consumed this run but the ` +
        `merged section is EMPTY. This is the "missing entries" regression — ` +
        `refusing to write an empty release. Check packages/*/CHANGELOG.md.`,
    );
    process.exit(1);
  }
  if (decision === "warn") {
    console.warn(
      `[sync-changelog] v${version}: merged section is empty and changeset ` +
        `consumption couldn't be verified (git unavailable). Writing an empty ` +
        `section — verify this release was meant to have no entries.`,
    );
  } else if (merged.trim().length === 0) {
    console.warn(
      `[sync-changelog] v${version}: writing an EMPTY section — no entries found ` +
        `across any package. Correct only if this release intentionally has none.`,
    );
  }
  if (merged.includes("(no description)")) {
    console.warn(
      `[sync-changelog] v${version}: an entry has no resolvable title (rendered ` +
        `"(no description)") — check the corresponding changeset/commit.`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const section = `## [${version}] — ${today}\n\n${merged}\n`;

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
  console.log(
    `[sync-changelog] promoted v${version} into root CHANGELOG.md ` +
      `(${dedupeEntries(entries).length} PR(s) across all packages).`,
  );
}

// Portable main-guard: true as an entrypoint (under bun or node), false on
// import (so the test suite can import the pure functions without side effects).
// `import.meta.main` doesn't exist on Node 22 (the CI test runner), so compare
// the module URL to argv[1] instead.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
