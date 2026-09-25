// Architectural Decision Records — one file per decision under docs/decisions/.
//
// Why one file each: five or six agents open PRs in parallel, and each one used
// to append its ADR to the single docs/DECISIONS.md. Every merge re-conflicted
// every other open ADR-bearing PR (a rebase plus a fresh review each time), and
// numbers collided constantly. With one file per decision, parallel PRs touch
// disjoint paths; a number collision is a one-file rename, caught by `check`.
//
// Subcommands (Makefile wrappers in parentheses):
//   check                     validate every ADR file (make adr-check; first step of make check)
//   index [--check]           regenerate docs/decisions/README.md (make adr-index)
//   new "<title>"             allocate the next free number, write a template (make adr NEW=…)
//   renumber <file>           move a colliding ADR to the next free number (make adr-renumber FILE=…)
//   import [<ref>]            move ADRs a branch appended to the old docs/DECISIONS.md into
//                             their own files (make adr-import REF=…)
//   migrate                   one-shot split of docs/DECISIONS.md (already run; kept for audit)
//
// Legacy entries (everything migrated from docs/DECISIONS.md) are listed in
// docs/decisions/legacy-manifest.json with a sha256 each. They are frozen
// history: `check` refuses any edit to them, and exempts them from the header /
// required-field rules that NEW entries must meet (they predate those rules, and
// rewriting them would falsify the log). The manifest is also the grandfather
// allowlist for historical numbering quirks — see docs/decisions/README.md.
//
// The index (docs/decisions/README.md) is NOT maintained by PRs — that would
// recreate the shared hotspot this layout exists to remove. The
// decisions-index workflow regenerates it after each merge to main.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DECISIONS_DIR = "docs/decisions";
export const LEGACY_LOG = "docs/DECISIONS.md";
export const MANIFEST_FILE = "legacy-manifest.json";
export const INDEX_FILE = "README.md";

/** Fields every NEW entry must carry (CLAUDE.md → "Decision Records"). */
export const REQUIRED_FIELDS = [
  "Date",
  "Decided by",
  "Context",
  "Decision",
  "Rationale",
  "Alternatives considered",
  "Source",
] as const;

// Legacy headers: `## ADR-NNN: Title`, plus the historical variants
// `## ADR-029-follow-up: …` and `## ADR-073 — …`.
const LEGACY_HEADER_RE = /^## ADR-(\d{3,}(?:-[a-z]+)*)\s*(?::|—)\s*(.+)$/;
// New entries: exactly `## ADR-NNN: Title`.
const NEW_HEADER_RE = /^## ADR-(\d{3,}): (\S.*)$/;
// New filenames: ADR-NNN-kebab-slug.md. Legacy files may carry a letter suffix
// on the number (ADR-029b-…) — that form is reserved for the manifest.
const NEW_FILE_RE = /^ADR-(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const ANY_ADR_FILE_RE = /^adr/i;

export const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex");
const pad = (n: number) => String(n).padStart(3, "0");

// ── shared parsing ──────────────────────────────────────────────────────────

export interface LegacyChunk {
  id: string;
  title: string;
  text: string;
}

/** Split the old single-file log at its `## ADR-…` headers. Lossless: preamble + Σ text === log. */
export function splitLog(log: string): {
  preamble: string;
  chunks: LegacyChunk[];
} {
  let preamble = "";
  const chunks: LegacyChunk[] = [];
  for (const line of log.split(/(?<=\n)/)) {
    const m = LEGACY_HEADER_RE.exec(line.replace(/\n$/, ""));
    if (m) chunks.push({ id: m[1]!, title: m[2]!.trim(), text: line });
    else if (chunks.length > 0) chunks[chunks.length - 1]!.text += line;
    else preamble += line;
  }
  return { preamble, chunks };
}

/**
 * Drop the inter-entry `---` separator and trailing blank lines from a chunk.
 * Returns the file content (ending in exactly one newline) and the exact bytes
 * removed, so content.slice(0, -1) + tail reproduces the chunk.
 */
export function trimSeparator(text: string): { content: string; tail: string } {
  let kept = text.replace(/\s+$/, "");
  while (kept.endsWith("\n---")) kept = kept.slice(0, -4).replace(/\s+$/, "");
  return { content: `${kept}\n`, tail: text.slice(kept.length) };
}

export function slugify(title: string, max = 60): string {
  const words = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > max && slug) break;
    slug = next;
  }
  return slug.slice(0, max) || "untitled";
}

export const numberOf = (id: string) => Number.parseInt(id, 10);

// ── migrate ─────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  file: string;
  id: string;
  sha256: string;
  tail: string;
}

export interface Manifest {
  _comment: string;
  source: { path: string; commit: string; sha256: string };
  preamble: string;
  entries: ManifestEntry[];
}

/** Split the log into per-decision files. A repeated number gets a letter suffix: 029, 029b, 029c. */
export function migrate(
  log: string,
  commit: string,
): { files: Map<string, string>; manifest: Manifest } {
  const { preamble, chunks } = splitLog(log);
  const files = new Map<string, string>();
  const seen = new Map<number, number>();
  const entries: ManifestEntry[] = [];
  for (const chunk of chunks) {
    const n = numberOf(chunk.id);
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    const suffix = count === 1 ? "" : String.fromCharCode(96 + count); // 2 → b
    // A worded id (029-follow-up) keeps its words in the slug so the file is findable by it.
    const words = chunk.id.replace(/^\d+-?/, "");
    const file = `ADR-${pad(n)}${suffix}-${slugify(`${words} ${chunk.title}`)}.md`;
    const { content, tail } = trimSeparator(chunk.text);
    files.set(file, content);
    entries.push({ file, id: chunk.id, sha256: sha256(content), tail });
  }
  return {
    files,
    manifest: {
      _comment:
        "Frozen record of the ADRs migrated from docs/DECISIONS.md. Listed files are append-only history: scripts/decisions.ts check rejects any edit. Order = original log order; tail = the separator bytes removed from each entry. Do not edit.",
      source: { path: LEGACY_LOG, commit, sha256: sha256(log) },
      preamble,
      entries,
    },
  };
}

/** Rebuild the original single-file log from the migrated files. */
export function reassemble(
  manifest: Manifest,
  read: (file: string) => string,
): string {
  let out = manifest.preamble;
  for (const e of manifest.entries) out += read(e.file).slice(0, -1) + e.tail;
  return out;
}

// ── loading ─────────────────────────────────────────────────────────────────

export interface Entry {
  file: string;
  id: string;
  num: number;
  title: string;
  text: string;
  legacy: boolean;
}

export function loadManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Manifest;
}

export function adrFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => ANY_ADR_FILE_RE.test(f))
    .sort();
}

/** Every ADR in `dir`: manifest files as legacy, everything else as new. Unparseable files are skipped (check reports them). */
export function loadEntries(dir: string, manifest: Manifest): Entry[] {
  const legacy = new Map(manifest.entries.map((e) => [e.file, e]));
  const out: Entry[] = [];
  for (const file of adrFiles(dir)) {
    const text = readFileSync(join(dir, file), "utf8");
    const first = text.split("\n", 1)[0] ?? "";
    const known = legacy.get(file);
    const m = (known ? LEGACY_HEADER_RE : NEW_HEADER_RE).exec(first);
    if (!m) continue;
    out.push({
      file,
      id: m[1]!,
      num: numberOf(m[1]!),
      title: m[2]!.trim(),
      text,
      legacy: !!known,
    });
  }
  return out;
}

// ── check ───────────────────────────────────────────────────────────────────

/** Value of a `**Label:**` field (bullet or plain line, or inline after `·`), up to the end of its line. */
export function fieldValue(text: string, label: string): string | undefined {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\*\\*${esc}:\\*\\*([^\\n]*)`).exec(text);
  if (!m) return undefined;
  return m[1]!
    .split(/\s·\s\*\*/)[0]!
    .replace(/\s—\s\*\*.*$/, "")
    .trim();
}

export function checkDecisions(root: string): string[] {
  const dir = join(root, DECISIONS_DIR);
  const errors: string[] = [];
  const rel = (f: string) => `${DECISIONS_DIR}/${f}`;
  const manifest = loadManifest(dir);

  // 1. Legacy entries are frozen.
  for (const e of manifest.entries) {
    const path = join(dir, e.file);
    if (!existsSync(path)) {
      errors.push(
        `${rel(e.file)} is missing. Migrated ADRs are permanent history; restore it.`,
      );
      continue;
    }
    if (sha256(readFileSync(path, "utf8")) !== e.sha256) {
      errors.push(
        `${rel(e.file)} was modified. Past ADRs are append-only history: never edit one. ` +
          'To reverse or amend it, write a NEW ADR (make adr NEW="…") that references it.',
      );
    }
  }

  // 2. The old single-file log stays a stub.
  const logPath = join(root, LEGACY_LOG);
  if (existsSync(logPath)) {
    const appended = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => LEGACY_HEADER_RE.test(l));
    if (appended.length > 0) {
      errors.push(
        `${LEGACY_LOG} gained ADR entries (${appended.map((l) => l.slice(3, 11)).join(", ")}). ` +
          `Decisions now live one per file in ${DECISIONS_DIR}/. Move them with: make adr-import REF=HEAD, ` +
          `then restore the stub: git checkout origin/main -- ${LEGACY_LOG}`,
      );
    }
  }

  // 3. New entries: filename ↔ header, required fields.
  const legacyFiles = new Set(manifest.entries.map((e) => e.file));
  for (const file of adrFiles(dir)) {
    if (legacyFiles.has(file)) continue;
    const fm = NEW_FILE_RE.exec(file);
    if (!fm) {
      errors.push(
        `${rel(file)}: bad filename. New ADRs are named ADR-NNN-kebab-slug.md (letter suffixes like 029b are reserved for migrated history).`,
      );
      continue;
    }
    const text = readFileSync(join(dir, file), "utf8");
    const first = text.split("\n", 1)[0] ?? "";
    const hm = NEW_HEADER_RE.exec(first);
    if (!hm) {
      errors.push(
        `${rel(file)}: the first line must be the header "## ADR-${fm[1]}: <Title>" (found: ${JSON.stringify(first)}).`,
      );
      continue;
    }
    if (hm[1] !== fm[1]) {
      errors.push(
        `${rel(file)}: header says ADR-${hm[1]} but the filename says ADR-${fm[1]}. Make them agree.`,
      );
    }
    for (const label of REQUIRED_FIELDS) {
      const v = fieldValue(text, label);
      if (v === undefined)
        errors.push(`${rel(file)}: missing required field **${label}:**`);
      else if (v === "" && !hasBlockValue(text, label))
        errors.push(`${rel(file)}: **${label}:** is empty`);
      else if (/\bTODO\b/.test(v))
        errors.push(
          `${rel(file)}: **${label}:** still holds the template's TODO`,
        );
    }
    const date = fieldValue(text, "Date");
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}\b/.test(date)) {
      errors.push(
        `${rel(file)}: **Date:** must start with YYYY-MM-DD (found: ${JSON.stringify(date)}).`,
      );
    }
  }

  // 4. No number is used twice, except the grandfathered legacy repeats.
  const entries = loadEntries(dir, manifest);
  const byNum = new Map<number, Entry[]>();
  for (const e of entries) byNum.set(e.num, [...(byNum.get(e.num) ?? []), e]);
  for (const [num, group] of byNum) {
    if (group.length < 2 || group.every((e) => e.legacy)) continue;
    const next = pad(Math.max(...entries.map((e) => e.num)) + 1);
    const newcomers = group.filter((e) => !e.legacy);
    errors.push(
      `ADR-${pad(num)} is used by ${group.length} files: ${group.map((e) => rel(e.file)).join(", ")}.\n` +
        "  Parallel PRs picked the same number; whoever merges LATER renumbers (one file, nothing else changes).\n" +
        `  Fix: ${newcomers.map((e) => `make adr-renumber FILE=${rel(e.file)}`).join("  or  ")}` +
        `  (next free on this branch: ADR-${next}; the script also checks open PRs).`,
    );
  }
  return errors;
}

/** A field whose value starts on the next lines (e.g. `**Rationale:**` then a bullet list). */
function hasBlockValue(text: string, label: string): boolean {
  const i = text.indexOf(`**${label}:**`);
  const after = text
    .slice(i + label.length + 6)
    .split("\n")
    .slice(1, 4)
    .join("\n");
  return after.trim() !== "" && !after.trimStart().startsWith("**");
}

// ── index ───────────────────────────────────────────────────────────────────

export interface Supersession {
  target: string; // "018", "029-follow-up"
  partial: boolean;
}

/**
 * Supersession, where parseable: the title's "(supersedes ADR-X)" / "(reverses part of ADR-X)"
 * and the first clause of a `**Supersedes:**` field. `ADR-X's …` means only part of X.
 */
export function supersessions(
  e: Pick<Entry, "title" | "text">,
): Supersession[] {
  const found = new Map<string, Supersession>();
  const add = (clause: string, partialClause: boolean) => {
    for (const m of clause.matchAll(/ADR-(\d{3,}(?:-follow-up)?)('s)?/g)) {
      const partial = partialClause || !!m[2];
      const prev = found.get(m[1]!);
      found.set(m[1]!, {
        target: m[1]!,
        partial: prev ? prev.partial && partial : partial,
      });
    }
  };
  for (const m of e.title.matchAll(
    /\b(supersedes|reverses(?: part of)?|replaces)\s+(ADR-\d{3,}(?:'s)?)/gi,
  )) {
    add(m[2]!, /part of/i.test(m[1]!));
  }
  const field = fieldValue(e.text, "Supersedes");
  if (field) add(field.split(/[(;.]|\sand\s/)[0]!, false);
  return [...found.values()];
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const label = (id: string) => `ADR-${id}`;

export function renderIndex(entries: Entry[]): string {
  const sorted = [...entries].sort(
    (a, b) => a.num - b.num || a.file.localeCompare(b.file),
  );
  const by = new Map<string, { full: string[]; part: string[] }>();
  const sup = new Map<string, Supersession[]>();
  for (const e of sorted) {
    const list = supersessions(e);
    sup.set(e.file, list);
    for (const s of list) {
      const slot = by.get(s.target) ?? { full: [], part: [] };
      (s.partial ? slot.part : slot.full).push(e.id);
      by.set(s.target, slot);
    }
  }
  const rows = sorted.map((e) => {
    const date =
      /\*\*Date:\*\*[^0-9\n]*(\d{4}-\d{2}-\d{2})/.exec(e.text)?.[1] ?? "";
    const inbound = by.get(e.id) ?? { full: [], part: [] };
    const explicit = e.legacy ? undefined : fieldValue(e.text, "Status");
    const status =
      explicit ||
      (inbound.full.length
        ? `Superseded by ${inbound.full.map(label).join(", ")}`
        : inbound.part.length
          ? `Amended by ${inbound.part.map(label).join(", ")}`
          : "Accepted");
    const supersedes = (sup.get(e.file) ?? [])
      .map((s) => `${label(s.target)}${s.partial ? " (in part)" : ""}`)
      .join(", ");
    const supersededBy = [
      ...inbound.full.map(label),
      ...inbound.part.map((id) => `${label(id)} (in part)`),
    ].join(", ");
    return `| [${label(e.id)}](${e.file}) | ${cell(e.title)} | ${date} | ${cell(status)} | ${supersedes} | ${supersededBy} |`;
  });
  return `${INDEX_PREAMBLE}| ADR | Title | Date | Status | Supersedes | Superseded by |
|---|---|---|---|---|---|
${rows.join("\n")}
`;
}

const INDEX_PREAMBLE = `<!-- GENERATED by scripts/decisions.ts — do not edit by hand. The decisions-index workflow
     regenerates this after every merge to main; run \`make adr-index\` to preview it locally. -->

# Architectural Decision Records

One file per decision. The old single-file log (\`docs/DECISIONS.md\`) was split
here so that parallel PRs stop conflicting on it.

## Adding a decision

\`\`\`sh
make adr NEW="Short decision title"   # takes the next free number (main + open PRs), writes a template
\`\`\`

Fill in every field; \`make check\` (and CI) rejects a new ADR missing any of
**Date** (YYYY-MM-DD), **Decided by**, **Context**, **Decision**, **Rationale**,
**Alternatives considered** or **Source**. Optional: **Status:** (defaults to
Accepted) and **Supersedes:** ADR-NNN (feeds the Superseded-by column below).

Don't edit this index in your PR; a bot PR regenerates it after yours merges.

**Number collision?** Two parallel PRs can pick the same number. CI names both
files; whoever merges later runs \`make adr-renumber FILE=docs/decisions/ADR-NNN-….md\`,
which moves the file to the next free number and rewrites its header. Code
comments that cite ADR numbers stay valid because numbers never change after merge.

## A PR that still appends to \`docs/DECISIONS.md\`

Branches opened before the split carry their ADR inside the old file. Move it once:

\`\`\`sh
git fetch origin && git merge origin/main       # conflicts only in docs/DECISIONS.md
make adr-import REF=HEAD                         # writes your entry to docs/decisions/ADR-NNN-….md
git checkout origin/main -- docs/DECISIONS.md    # keep main's stub
git add -A && git commit --no-edit && make adr-check
\`\`\`

\`adr-import\` keeps your number if it's free and otherwise takes the next free one (it
says so; update any references to the old number in your PR).

## Rules

- **Append-only.** Never edit or delete a past decision. To reverse one, add a new
  ADR that references it. Migrated entries are hash-locked in
  [\`legacy-manifest.json\`](legacy-manifest.json), and CI fails on any edit.
- **Historical quirks are kept, not fixed.** Migrated entries keep their exact text,
  including older field formats and header styles (\`ADR-073 — …\`). A number that
  appears twice in history gets a letter suffix in its FILENAME only: the second
  ADR-029 (\`ADR-029-follow-up\`) is \`ADR-029b-….md\`. Letter suffixes are reserved
  for migrated entries; new ADRs are always \`ADR-NNN-kebab-slug.md\`.
- **Status / supersession** below are derived where parseable (a title's
  "supersedes ADR-X" / "reverses part of ADR-X", or a \`**Supersedes:**\` field). For
  anything subtler, read the entry.

## Index

`;

// ── numbering ───────────────────────────────────────────────────────────────

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/** ADR numbers in a list of paths (docs/decisions/ADR-NNN-*.md) and in `+## ADR-NNN` diff lines. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:^|\/)ADR-(\d{3,})[a-z]?-[^/\s]*\.md$/gm))
    out.push(numberOf(m[1]!));
  for (const m of text.matchAll(/^\+## ADR-(\d{3,})/gm))
    out.push(numberOf(m[1]!));
  return out;
}

/**
 * Every number already claimed: this checkout, origin/main, and open PRs (new files, plus
 * legacy `+## ADR-NNN` appends to docs/DECISIONS.md during the transition). Sources that
 * are unavailable (offline, no gh) are skipped with a warning, never fatal.
 */
export function claimedNumbers(
  root: string,
  opts: { excludeFile?: string } = {},
): { nums: number[]; warnings: string[] } {
  const warnings: string[] = [];
  const dir = join(root, DECISIONS_DIR);
  const nums = adrFiles(dir)
    .filter((f) => f !== opts.excludeFile)
    .flatMap((f) => numbersIn(f));
  try {
    git(root, ["fetch", "--quiet", "origin", "main"]);
  } catch {
    warnings.push(
      "could not fetch origin/main; using the local origin/main ref",
    );
  }
  try {
    nums.push(
      ...numbersIn(
        git(root, [
          "ls-tree",
          "-r",
          "--name-only",
          "origin/main",
          `${DECISIONS_DIR}/`,
        ]),
      ),
    );
    nums.push(
      ...numbersIn(
        git(root, ["show", `origin/main:${LEGACY_LOG}`]).replace(
          /^## /gm,
          "+## ",
        ),
      ),
    );
  } catch {
    warnings.push("origin/main unavailable; skipped it");
  }
  try {
    const prs = JSON.parse(
      execFileSync(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,files",
        ],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 30_000,
        },
      ),
    ) as { number: number; files: { path: string }[] }[];
    for (const pr of prs) {
      const paths = pr.files.map((f) => f.path);
      nums.push(
        ...numbersIn(
          paths.filter((p) => p.startsWith(`${DECISIONS_DIR}/`)).join("\n"),
        ),
      );
      if (paths.includes(LEGACY_LOG)) {
        try {
          const diff = execFileSync("gh", ["pr", "diff", String(pr.number)], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 30_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          nums.push(...numbersIn(diff));
        } catch {
          warnings.push(`could not read the diff of PR #${pr.number}`);
        }
      }
    }
  } catch {
    warnings.push(
      "gh unavailable or unauthenticated; open PRs NOT checked (CI still catches a collision)",
    );
  }
  return { nums, warnings };
}

export const nextNumber = (nums: number[]) =>
  (nums.length ? Math.max(...nums) : 0) + 1;

export function template(num: number, title: string, today: string): string {
  return `## ADR-${pad(num)}: ${title}

- **Date:** ${today}
- **Decided by:** TODO (who decided: Terry / an agent, and in what role)
- **Context:** TODO (why this decision was needed)
- **Decision:** TODO (what was chosen)
- **Rationale:** TODO (why this over the alternatives)
- **Alternatives considered:** TODO (what else was evaluated, and why not)
- **Source:** TODO (where it was decided: PR, agent channel, session)
`;
}

// ── commands ────────────────────────────────────────────────────────────────

function writeIndex(root: string, checkOnly: boolean): boolean {
  const dir = join(root, DECISIONS_DIR);
  const want = renderIndex(loadEntries(dir, loadManifest(dir)));
  const path = join(dir, INDEX_FILE);
  const have = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (checkOnly) return have === want;
  if (have !== want) writeFileSync(path, want);
  return true;
}

function renumber(root: string, fileArg: string): string {
  const dir = join(root, DECISIONS_DIR);
  const file = fileArg.split("/").pop()!;
  const m = NEW_FILE_RE.exec(file);
  if (!m)
    throw new Error(`${fileArg}: not a new-style ADR file (ADR-NNN-slug.md)`);
  const { nums, warnings } = claimedNumbers(root, { excludeFile: file });
  for (const w of warnings) console.warn(`warning: ${w}`);
  const n = pad(nextNumber(nums));
  const target = `ADR-${n}-${m[2]}.md`;
  const text = readFileSync(join(dir, file), "utf8").replace(
    new RegExp(`^## ADR-${m[1]}: `),
    `## ADR-${n}: `,
  );
  writeFileSync(join(dir, file), text);
  try {
    git(root, ["mv", join(DECISIONS_DIR, file), join(DECISIONS_DIR, target)]);
  } catch {
    renameSync(join(dir, file), join(dir, target));
  }
  return `${DECISIONS_DIR}/${target}`;
}

/**
 * Entries in an old-style log that aren't recorded yet: what a branch appended. An entry is
 * already recorded if its bytes match a migrated one, or its title matches any ADR file.
 * Matching on title covers a branch forked before a past entry was amended (an older copy),
 * and a stacked branch whose base PR already imported the entry under a new number. A reused
 * number under a different title is a new entry.
 */
export function appendedEntries(
  log: string,
  manifest: Manifest,
  knownTitles: Set<string>,
): { id: string; title: string; content: string }[] {
  const hashes = new Set(manifest.entries.map((e) => e.sha256));
  return splitLog(log)
    .chunks.map((c) => ({
      id: c.id,
      title: c.title,
      content: trimSeparator(c.text).content,
    }))
    .filter((c) => !hashes.has(sha256(c.content)) && !knownTitles.has(c.title));
}

/**
 * Move the ADRs a branch appended to the old docs/DECISIONS.md into their own files.
 * Keeps each entry's number unless it's taken here, else takes the next free one.
 */
function importFrom(root: string, ref: string): string[] {
  const dir = join(root, DECISIONS_DIR);
  const log = git(root, ["show", `${ref}:${LEGACY_LOG}`]);
  const manifest = loadManifest(dir);
  const titles = new Set(loadEntries(dir, manifest).map((e) => e.title));
  const written: string[] = [];
  for (const entry of appendedEntries(log, manifest, titles)) {
    if (titles.has(entry.title)) continue; // the same entry twice in one log
    titles.add(entry.title);
    const taken = adrFiles(dir).flatMap((f) => numbersIn(f));
    let num = numberOf(entry.id);
    if (taken.includes(num) || !/^\d+$/.test(entry.id)) {
      const { nums, warnings } = claimedNumbers(root);
      for (const w of warnings) console.warn(`warning: ${w}`);
      num = nextNumber([...nums, ...taken]);
      console.warn(
        `ADR-${entry.id} is taken; imported as ADR-${pad(num)}. Update references to ADR-${entry.id} in your PR.`,
      );
    }
    // The header takes the new-entry form; the body is kept as written.
    const content = entry.content.replace(
      /^[^\n]*/,
      `## ADR-${pad(num)}: ${entry.title}`,
    );
    const file = `ADR-${pad(num)}-${slugify(entry.title)}.md`;
    writeFileSync(join(dir, file), content);
    written.push(`${DECISIONS_DIR}/${file}`);
  }
  return written;
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  const root = REPO_ROOT;
  switch (cmd) {
    case "check": {
      const errors = checkDecisions(root);
      if (errors.length === 0) {
        console.log(`✓ ${DECISIONS_DIR}: all ADRs valid`);
        return 0;
      }
      console.error(`✗ ${DECISIONS_DIR}: ${errors.length} problem(s)\n`);
      for (const e of errors) console.error(`- ${e}`);
      return 1;
    }
    case "index": {
      const checkOnly = args.includes("--check");
      const ok = writeIndex(root, checkOnly);
      if (checkOnly && !ok) {
        console.error(
          `✗ ${DECISIONS_DIR}/${INDEX_FILE} is stale; run: make adr-index`,
        );
        return 1;
      }
      console.log(
        checkOnly ? "✓ index is fresh" : `wrote ${DECISIONS_DIR}/${INDEX_FILE}`,
      );
      return 0;
    }
    case "new": {
      const title = args.join(" ").trim();
      if (!title) {
        console.error('usage: make adr NEW="Short decision title"');
        return 2;
      }
      const { nums, warnings } = claimedNumbers(root);
      for (const w of warnings) console.warn(`warning: ${w}`);
      const num = nextNumber(nums);
      const file = join(DECISIONS_DIR, `ADR-${pad(num)}-${slugify(title)}.md`);
      writeFileSync(
        join(root, file),
        template(num, title, new Date().toISOString().slice(0, 10)),
      );
      console.log(file);
      return 0;
    }
    case "renumber": {
      if (!args[0]) {
        console.error(
          "usage: make adr-renumber FILE=docs/decisions/ADR-NNN-slug.md",
        );
        return 2;
      }
      const to = renumber(root, args[0]);
      console.log(
        `→ ${to}\nUpdate any references to the old number in your PR (code comments, PR body).`,
      );
      return 0;
    }
    case "import": {
      const written = importFrom(root, args[0] || "HEAD");
      if (written.length === 0)
        console.log(`no new ADRs in ${args[0] || "HEAD"}:${LEGACY_LOG}`);
      for (const f of written) console.log(`wrote ${f}`);
      return 0;
    }
    case "migrate": {
      const dir = join(root, DECISIONS_DIR);
      mkdirSync(dir, { recursive: true });
      const commit = git(root, ["rev-parse", "HEAD"]).trim();
      const { files, manifest } = migrate(
        readFileSync(join(root, LEGACY_LOG), "utf8"),
        commit,
      );
      for (const [file, content] of files)
        writeFileSync(join(dir, file), content);
      writeFileSync(
        join(dir, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      console.log(
        `migrated ${files.size} ADRs into ${relative(root, dir)}/ (source ${commit.slice(0, 7)})`,
      );
      return 0;
    }
    default:
      console.error(
        "usage: decisions.ts check | index [--check] | new <title> | renumber <file> | import [<ref>] | migrate",
      );
      return 2;
  }
}

// Portable main-guard (see sync-changelog.ts): true as an entrypoint, false on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
