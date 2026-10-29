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
//   index                     print the index table: number, title, date, status, supersession (make adr-index)
//   new "<title>"             allocate the next free number, write a template (make adr NEW=…)
//   renumber <file>           move a colliding ADR to the next free number (make adr-renumber FILE=…)
//   import [<ref>]            move ADRs a branch appended to the old docs/DECISIONS.md into
//                             their own files (make adr-import REF=…)
//   migrate [<ref>] --force   split <ref>:docs/DECISIONS.md (already run; re-run on the latest
//                             main before the split merges, so late appends migrate as legacy)
//
// Legacy entries (everything migrated from docs/DECISIONS.md) are listed in
// docs/decisions/legacy-manifest.json with a sha256 each. They are frozen
// history: `check` refuses any edit to them, and exempts them from the header /
// required-field rules that NEW entries must meet (they predate those rules, and
// rewriting them would falsify the log). The manifest is also the grandfather
// allowlist for historical numbering quirks — see docs/decisions/README.md.
//
// The index table is never committed (ADR-157): a committed one is a file every ADR PR
// edits, the shared hotspot this layout exists to remove, and keeping it fresh took a
// bot. `make adr-index` prints it from the files; docs/decisions/README.md is a static guide.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DECISIONS_DIR = "docs/decisions";
export const LEGACY_LOG = "docs/DECISIONS.md";
export const MANIFEST_FILE = "legacy-manifest.json";
/** The static guide to this directory (not an index: that is printed, never committed). */
const GUIDE_FILE = "README.md";

/**
 * docs/DECISIONS.md after the split: a pointer, pinned byte for byte by `check`, so no
 * decision can be recorded there (in any header spelling) and the pointer can't vanish.
 */
export const LEGACY_STUB = `# Architectural Decision Records → [\`docs/decisions/\`](decisions/)

This log moved: **every decision is now its own file** in
[\`docs/decisions/\`](decisions/), named \`ADR-NNN-<slug>.md\`, with a guide in
[\`docs/decisions/README.md\`](decisions/README.md). ADR numbers did not change, so
existing "ADR-NNN" references (code comments, PRs, notes) still point at the same
decision: open \`docs/decisions/ADR-NNN-*.md\`.

- **Add a decision:** \`make adr NEW="Short title"\`. Do not append here; CI rejects
  any change to this file.
- **Have an open PR that appended an entry here?** Run \`make adr-import REF=HEAD\`
  while merging main, then keep main's version of this file. See the steps in
  [\`docs/decisions/README.md\`](decisions/README.md).

The migrated entries are byte-for-byte what this file held (verified by
\`scripts/decisions.test.ts\` against the SHA-256 in
[\`legacy-manifest.json\`](decisions/legacy-manifest.json)).
`;

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

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

/** Repo-relative path of a file in the decisions directory. */
function relPath(file: string): string {
  return `${DECISIONS_DIR}/${file}`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

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

export function numberOf(id: string): number {
  return Number.parseInt(id, 10);
}

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
    const known = legacy.get(file);
    const m = (known ? LEGACY_HEADER_RE : NEW_HEADER_RE).exec(firstLine(text));
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

// A line that starts a field: `**Label:**` or `- **Label:**`. Also where a block value ends.
const FIELD_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\*\*[^*\n]+:\*\*/;
const HEADING_RE = /^#{1,6}\s/;

/** Blank out fenced code blocks, so a field shown inside ``` doesn't count as one. */
function withoutCodeFences(text: string): string {
  return text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "");
}

export interface Field {
  /** The rest of the label's line, cut at an inline next field (`… · **Next:**`). */
  inline: string;
  /** `inline` plus any continuation lines up to the next field line or heading. */
  body: string;
}

/**
 * A `**Label:**` field: at the start of a line (plain or bullet), or inline after ` · ` / ` — `
 * on a field line (`- **Date:** … · **Decided by:** …`). A mention in prose, or inside a
 * fenced code block, is not a field.
 */
export function field(text: string, label: string): Field | undefined {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const atStart = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*${esc}:\\*\\*`);
  const inline = new RegExp(`\\s[·—]\\s\\*\\*${esc}:\\*\\*`);
  const lines = withoutCodeFences(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m =
      atStart.exec(line) ??
      (FIELD_LINE_RE.test(line) ? inline.exec(line) : null);
    if (!m) continue;
    const value = line
      .slice(m.index + m[0].length)
      .replace(/\s[·—]\s\*\*.*$/, "")
      .trim();
    const rest: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (FIELD_LINE_RE.test(lines[j]!) || HEADING_RE.test(lines[j]!)) break;
      rest.push(lines[j]!);
    }
    return { inline: value, body: [value, ...rest].join("\n").trim() };
  }
  return undefined;
}

export function fieldValue(text: string, label: string): string | undefined {
  return field(text, label)?.inline;
}

/** YYYY-MM-DD at the start of `s`, and a real calendar date. */
function isIsoDate(s: string): boolean {
  const d = /^(\d{4}-\d{2}-\d{2})\b/.exec(s)?.[1];
  if (!d) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export function checkDecisions(root: string): string[] {
  const dir = join(root, DECISIONS_DIR);
  const manifest = loadManifest(dir);
  return [
    ...checkLegacyFrozen(dir, manifest),
    ...checkLegacyLogIsStub(root),
    ...checkDirectoryContents(dir),
    ...checkGuideIsNotTheIndex(dir),
    ...checkNewEntries(dir, manifest),
    ...checkNumbersUnique(root, dir, manifest),
  ];
}

/** Legacy entries are frozen. */
function checkLegacyFrozen(dir: string, manifest: Manifest): string[] {
  const errors: string[] = [];
  for (const e of manifest.entries) {
    const path = join(dir, e.file);
    if (!existsSync(path)) {
      errors.push(
        `${relPath(e.file)} is missing. Migrated ADRs are permanent history; restore it.`,
      );
    } else if (sha256(readFileSync(path, "utf8")) !== e.sha256) {
      errors.push(
        `${relPath(e.file)} was modified. Past ADRs are append-only history: never edit one. ` +
          'To reverse or amend it, write a NEW ADR (make adr NEW="…") that references it.',
      );
    }
  }
  return errors;
}

/** The old single-file log stays the pinned stub: nothing appended, nothing removed. */
function checkLegacyLogIsStub(root: string): string[] {
  const logPath = join(root, LEGACY_LOG);
  if (!existsSync(logPath)) {
    return [
      `${LEGACY_LOG} is missing. Keep the pointer stub (external links and notes use it): git checkout origin/main -- ${LEGACY_LOG}`,
    ];
  }
  const text = readFileSync(logPath, "utf8");
  if (text === LEGACY_STUB) return [];
  const headers = text.split("\n").filter((l) => /^#{1,6}\s*ADR\b/i.test(l));
  return [
    `${LEGACY_LOG} changed. It is a frozen pointer; decisions live one per file in ${DECISIONS_DIR}/.` +
      (headers.length
        ? ` It gained ADR entries (${headers.map((l) => JSON.stringify(l.slice(0, 40))).join(", ")}): move them with make adr-import REF=HEAD, then`
        : " To undo it,") +
      ` restore the stub: git checkout origin/main -- ${LEGACY_LOG}`,
  ];
}

/** Only ADR files, the guide and the manifest live in docs/decisions/ (so nothing escapes check). */
function checkDirectoryContents(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        !d.isFile() ||
        !(
          d.name === GUIDE_FILE ||
          d.name === MANIFEST_FILE ||
          ANY_ADR_FILE_RE.test(d.name)
        ),
    )
    .map(
      (d) =>
        `${relPath(d.name)}: unexpected ${d.isFile() ? "file" : "entry"}. ${DECISIONS_DIR}/ holds only ADR-NNN-slug.md files, ${GUIDE_FILE} and ${MANIFEST_FILE}.`,
    );
}

/** docs/decisions/README.md is the hand-written guide, never the generated table (ADR-157). */
function checkGuideIsNotTheIndex(dir: string): string[] {
  const path = join(dir, GUIDE_FILE);
  if (
    !existsSync(path) ||
    !readFileSync(path, "utf8").startsWith(INDEX_HEADING)
  )
    return [];
  return [
    `${relPath(GUIDE_FILE)} holds the generated index table. It is the hand-written guide; the table is never committed (ADR-157). Restore it: git checkout origin/main -- ${relPath(GUIDE_FILE)}`,
  ];
}

/** New entries: filename ↔ header, required fields. */
function checkNewEntries(dir: string, manifest: Manifest): string[] {
  const legacyFiles = new Set(manifest.entries.map((e) => e.file));
  return adrFiles(dir)
    .filter((file) => !legacyFiles.has(file))
    .flatMap((file) => checkNewEntry(dir, file));
}

function checkNewEntry(dir: string, file: string): string[] {
  const fm = NEW_FILE_RE.exec(file);
  if (!fm) {
    return [
      `${relPath(file)}: bad filename. New ADRs are named ADR-NNN-kebab-slug.md (letter suffixes like 029b are reserved for migrated history).`,
    ];
  }
  const text = readFileSync(join(dir, file), "utf8");
  const first = firstLine(text);
  const hm = NEW_HEADER_RE.exec(first);
  if (!hm) {
    return [
      `${relPath(file)}: the first line must be the header "## ADR-${fm[1]}: <Title>" (found: ${JSON.stringify(first)}).`,
    ];
  }
  const errors: string[] = [];
  if (hm[1] !== fm[1]) {
    errors.push(
      `${relPath(file)}: header says ADR-${hm[1]} but the filename says ADR-${fm[1]}. Make them agree.`,
    );
  }
  for (const label of REQUIRED_FIELDS) {
    const f = field(text, label);
    if (f === undefined) {
      errors.push(`${relPath(file)}: missing required field **${label}:**`);
    } else if (f.body === "") {
      errors.push(`${relPath(file)}: **${label}:** is empty`);
    } else if (/\bTODO\b/.test(f.body)) {
      errors.push(
        `${relPath(file)}: **${label}:** still holds the template's TODO`,
      );
    }
  }
  const date = fieldValue(text, "Date");
  if (date && !isIsoDate(date)) {
    errors.push(
      `${relPath(file)}: **Date:** must start with a real YYYY-MM-DD date (found: ${JSON.stringify(date)}).`,
    );
  }
  return errors;
}

/** No number is used twice, except the grandfathered legacy repeats. */
function checkNumbersUnique(
  root: string,
  dir: string,
  manifest: Manifest,
): string[] {
  const entries = loadEntries(dir, manifest);
  const next = pad(Math.max(...entries.map((e) => e.num)) + 1);
  const byNum = new Map<number, Entry[]>();
  for (const e of entries) {
    const group = byNum.get(e.num);
    if (group) group.push(e);
    else byNum.set(e.num, [e]);
  }
  const errors: string[] = [];
  for (const group of byNum.values()) {
    if (group.length < 2 || group.every((e) => e.legacy)) continue;
    const newcomers = group.filter((e) => !e.legacy);
    // Without history (CI checks out shallow) the notes are empty, so say how to find out
    // which file merged later: renumbering the earlier one would strand its references.
    const notes = group.map((e) => addedInNote(root, e.file));
    const whoIsLater = notes.every((n) => n !== "")
      ? ""
      : `\n  Which merged later? git log --diff-filter=A --format='%h %ad %s' --date=short -- ${group.map((e) => relPath(e.file)).join(" ")}`;
    errors.push(
      `ADR-${pad(group[0]!.num)} is used by ${group.length} files: ${group.map((e, k) => relPath(e.file) + notes[k]).join(", ")}.\n` +
        "  Parallel PRs picked the same number; whoever merges LATER renumbers (one file, nothing else changes).\n" +
        `  Fix: ${newcomers.map((e) => `make adr-renumber FILE=${relPath(e.file)}`).join("  or  ")}` +
        `  (next free on this branch: ADR-${next}; the script also checks open PRs).` +
        " If both PRs already merged, whoever merged later runs it in a follow-up PR." +
        whoIsLater,
    );
  }
  return errors;
}

// ── who added a file (for collision messages) ──────────────────────────────

function isShallow(root: string): boolean {
  return git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
}

/**
 * ` (added in <sha> "<subject>")`: the first-parent commit that added `docs/decisions/<file>`
 * at that path (a rename counts). Never throws, and says nothing for an uncommitted file or in
 * a shallow clone (where git would blame the one grafted commit for every file).
 */
function addedInNote(root: string, file: string): string {
  try {
    if (isShallow(root)) return "";
    const line = git(root, [
      "log",
      "--first-parent",
      "--no-renames",
      "--diff-filter=A",
      "--format=%H%x09%s",
      "-1",
      "--",
      relPath(file),
    ]).trim();
    if (!line) return "";
    const [sha, ...subject] = line.split("\t");
    return ` (added in ${sha!.slice(0, 7)} "${subject.join("\t")}")`;
  } catch {
    return "";
  }
}

// ── index ───────────────────────────────────────────────────────────────────

export interface Supersession {
  target: string; // "018", "029-follow-up"
  partial: boolean;
}

/** Fields naming what an entry supersedes. The last three are legacy spellings; they mean "in part". */
const SUPERSEDES_LABELS = [
  "Supersedes",
  "Supersedes / amends",
  "Reverses",
  "Amends",
];

/** A target's own parenthetical says only part of it is replaced: "(part: …)", "(…, in part)", "(…; the rest stands)". */
const PARTIAL_PAREN_RE =
  /^\s*part\s*:|\bin part\b|\bpartially\b|\bthe rest of\b|\bstands\b|\bonly\b|\b(?:outcome|pick|decision)s?\s+\d/i;

interface SupersedesRef {
  id: string;
  possessive: boolean;
  /** Where the ref's text starts; "ADR-041/040" yields two refs at the same spot. */
  at: number;
  /** End of the ref, or of the parenthetical that directly follows it. */
  end: number;
  paren: string;
}

/**
 * The ADRs one `**Supersedes:**`-style value names, each with its own "in part" verdict.
 *
 * Only the first sentence counts ("…. Composes with ADR-040" is context), and a value that
 * opens with "none" / "nothing" names no target. Every ADR ref OUTSIDE parentheses is a target
 * (a ref inside one is explanation: "(…, narrowed by ADR-100)"). A target is partial when:
 * it is possessive ("ADR-041's premise"); descriptive text precedes it ("part of ADR-049",
 * "the cookie lineage of ADR-041"); or its own parenthetical says so (PARTIAL_PAREN_RE). A
 * bare "partial", or "part of" inside a parenthetical, is NOT a marker: "(the partial-write
 * fix)" and "(it was part of the old design)" describe history, not scope.
 */
export function parseSupersedesValue(
  value: string,
  allPartial = false,
): Supersession[] {
  const text = value.replace(/\*+/g, ""); // **ADR-057** → ADR-057
  if (/^\s*(?:none|nothing)\b/i.test(text)) return [];
  const refs: SupersedesRef[] = [];
  let depth = 0;
  let parenStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(") {
      if (depth++ === 0) parenStart = i + 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0 && --depth === 0) {
        // A parenthetical right after a ref (only spaces/quotes between) belongs to it.
        const at = refs.length ? refs[refs.length - 1]!.at : -1;
        const mine = refs.filter((r) => r.at === at && !r.paren);
        if (
          mine.length &&
          /^[\s"'`]*$/.test(text.slice(mine[0]!.end, parenStart - 1))
        ) {
          for (const r of mine)
            Object.assign(r, { paren: text.slice(parenStart, i), end: i + 1 });
        }
      }
      continue;
    }
    if (depth > 0) continue;
    // The first top-level sentence end stops the scan.
    if ((ch === "." && /\s/.test(text[i + 1] ?? " ")) || ch === ";") break;
    const m = /^ADR-(\d{3,}(?:-follow-up)?)((?:\/\d{3,})*)('s)?/.exec(
      text.slice(i),
    );
    if (!m || /[\w-]/.test(text[i - 1] ?? "")) continue;
    const end = i + m[0].length;
    for (const id of [m[1]!, ...m[2]!.split("/").filter(Boolean)]) {
      refs.push({ id, possessive: !!m[3], at: i, end, paren: "" });
    }
    i = end - 1;
  }
  // Each distinct ref position's lead: the text since the previous target, minus list glue.
  const starts = [...new Set(refs.map((r) => r.at))];
  const leadIsPartial = new Map<number, boolean>();
  starts.forEach((at, k) => {
    const prevEnd =
      k === 0
        ? 0
        : Math.max(
            ...refs.filter((r) => r.at === starts[k - 1]).map((r) => r.end),
          );
    const lead = text
      .slice(prevEnd, at)
      .replace(/^[\s,]*(?:and|or|&)?[\s,]*/i, "");
    leadIsPartial.set(at, /[a-z]/i.test(lead));
  });
  return refs.map((r) => ({
    target: r.id,
    partial:
      allPartial ||
      r.possessive ||
      leadIsPartial.get(r.at)! ||
      PARTIAL_PAREN_RE.test(r.paren),
  }));
}

/**
 * Supersession, where parseable: the title's "(supersedes ADR-X)" / "(reverses part of ADR-X)",
 * and a `**Supersedes:**` field or a legacy spelling of one (see parseSupersedesValue).
 */
export function supersessions(
  e: Pick<Entry, "title" | "text">,
): Supersession[] {
  const found = new Map<string, Supersession>();
  const add = (s: Supersession) => {
    const prev = found.get(s.target);
    found.set(s.target, {
      target: s.target,
      partial: prev ? prev.partial && s.partial : s.partial,
    });
  };
  for (const m of e.title.matchAll(
    /\b(supersedes|reverses(?: part of)?|replaces)\s+ADR-(\d{3,}(?:-follow-up)?)('s)?/gi,
  )) {
    add({ target: m[2]!, partial: /part of/i.test(m[1]!) || !!m[3] });
  }
  for (const label of SUPERSEDES_LABELS) {
    const f = field(e.text, label);
    if (f)
      for (const s of parseSupersedesValue(f.body, label !== "Supersedes"))
        add(s);
  }
  return [...found.values()];
}

/** Ids of the entries that supersede one ADR, fully or in part. */
interface Inbound {
  full: string[];
  part: string[];
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function adrLabel(id: string): string {
  return `ADR-${id}`;
}

/** An explicit (non-legacy) `**Status:**` wins; otherwise derive it from inbound supersession. */
function statusOf(e: Entry, inbound: Inbound): string {
  const explicit = e.legacy ? undefined : fieldValue(e.text, "Status");
  if (explicit) return explicit;
  if (inbound.full.length) {
    return `Superseded by ${inbound.full.map(adrLabel).join(", ")}`;
  }
  if (inbound.part.length) {
    return `Amended by ${inbound.part.map(adrLabel).join(", ")}`;
  }
  return "Accepted";
}

export function renderIndex(entries: Entry[]): string {
  const sorted = [...entries].sort(
    (a, b) => a.num - b.num || a.file.localeCompare(b.file),
  );
  const inboundById = new Map<string, Inbound>();
  const outboundByFile = new Map<string, Supersession[]>();
  for (const e of sorted) {
    const list = supersessions(e);
    outboundByFile.set(e.file, list);
    for (const s of list) {
      const slot = inboundById.get(s.target) ?? { full: [], part: [] };
      (s.partial ? slot.part : slot.full).push(e.id);
      inboundById.set(s.target, slot);
    }
  }
  const rows = sorted.map((e) => {
    const date =
      /\*\*Date:\*\*[^0-9\n]*(\d{4}-\d{2}-\d{2})/.exec(e.text)?.[1] ?? "";
    const inbound = inboundById.get(e.id) ?? { full: [], part: [] };
    const supersedes = (outboundByFile.get(e.file) ?? [])
      .map((s) => `${adrLabel(s.target)}${s.partial ? " (in part)" : ""}`)
      .join(", ");
    const supersededBy = [
      ...inbound.full.map(adrLabel),
      ...inbound.part.map((id) => `${adrLabel(id)} (in part)`),
    ].join(", ");
    return `| [${adrLabel(e.id)}](${e.file}) | ${cell(e.title)} | ${date} | ${cell(statusOf(e, inbound))} | ${supersedes} | ${supersededBy} |`;
  });
  return `${INDEX_PREAMBLE}| ADR | Title | Date | Status | Supersedes | Superseded by |
|---|---|---|---|---|---|
${rows.join("\n")}
`;
}

const INDEX_HEADING = "# Architectural Decision Records: index";
const INDEX_PREAMBLE = `${INDEX_HEADING}

Generated by \`make adr-index\` from docs/decisions/ADR-*.md. Status and supersession are
derived where parseable; read the entry for anything subtler.

`;

// ── numbering ───────────────────────────────────────────────────────────────

/** Run a command and return its stdout; on failure the error carries the command's stderr. */
function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(
      `${cmd} ${args.join(" ")}: ${(e.stderr || e.message).trim().split("\n")[0]}`,
    );
  }
}

const why = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function git(root: string, args: string[]): string {
  return run("git", ["-C", root, ...args]);
}

function gh(
  root: string,
  args: string[],
  options: { maxBuffer?: number } = {},
): string {
  return run("gh", args, { cwd: root, timeout: 30_000, ...options });
}

/** ADR numbers in a list of paths (docs/decisions/ADR-NNN-*.md) and in `+## ADR-NNN` diff lines. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:^|\/)ADR-(\d{3,})[a-z]?-[^/\s]*\.md$/gm))
    out.push(numberOf(m[1]!));
  for (const m of text.matchAll(/^\+## ADR-(\d{3,})/gm))
    out.push(numberOf(m[1]!));
  return out;
}

const PR_LIST_LIMIT = 200;
/** `gh pr list --json files` returns at most this many files per PR. */
const GH_FILES_CAP = 100;

/**
 * Every number already claimed: this checkout, origin/main, and open PRs (new files, plus
 * legacy `+## ADR-NNN` appends to docs/DECISIONS.md during the transition). A source that is
 * unavailable (offline, no gh) is skipped with a warning saying why, never fatal: CI's
 * duplicate check is the backstop; each warning goes to stderr. ADR_OFFLINE=1 skips the
 * network sources (tests).
 */
function claimedNumbers(root: string, excludeFile?: string): number[] {
  const warn = (w: string) => console.warn(`warning: ${w}`);
  const nums = adrFiles(join(root, DECISIONS_DIR))
    .filter((f) => f !== excludeFile)
    .flatMap((f) => numbersIn(f));
  if (process.env.ADR_OFFLINE === "1") {
    warn("ADR_OFFLINE=1: origin/main and open PRs not checked");
    return nums;
  }
  try {
    git(root, ["fetch", "--quiet", "origin", "main"]);
  } catch (err) {
    warn(
      `could not fetch origin/main (${why(err)}); using the local origin/main ref`,
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
  } catch (err) {
    warn(`origin/main's ${DECISIONS_DIR}/ not read (${why(err)})`);
  }
  try {
    // Count main's legacy-log headers as if they were `+## ADR-NNN` diff lines.
    const mainLog = git(root, ["show", `origin/main:${LEGACY_LOG}`]);
    nums.push(...numbersIn(mainLog.replace(/^## /gm, "+## ")));
  } catch (err) {
    warn(`origin/main's ${LEGACY_LOG} not read (${why(err)})`);
  }
  let prs: {
    number: number;
    changedFiles: number;
    files: { path: string }[];
  }[];
  try {
    prs = JSON.parse(
      gh(root, [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(PR_LIST_LIMIT),
        "--json",
        "number,changedFiles,files",
      ]),
    );
  } catch (err) {
    warn(`open PRs NOT checked (${why(err)}); CI still catches a collision`);
    return nums;
  }
  if (prs.length >= PR_LIST_LIMIT) {
    warn(
      `${prs.length} open PRs: only the newest ${PR_LIST_LIMIT} were checked`,
    );
  }
  for (const pr of prs) {
    let paths = pr.files.map((f) => f.path);
    if (pr.changedFiles > GH_FILES_CAP) {
      try {
        paths = gh(root, [
          "pr",
          "diff",
          String(pr.number),
          "--name-only",
        ]).split("\n");
      } catch (err) {
        warn(
          `PR #${pr.number} has ${pr.changedFiles} files; only ${GH_FILES_CAP} checked (${why(err)})`,
        );
      }
    }
    nums.push(
      ...numbersIn(
        paths.filter((p) => p.startsWith(`${DECISIONS_DIR}/`)).join("\n"),
      ),
    );
    if (!paths.includes(LEGACY_LOG)) continue;
    try {
      const diff = gh(root, ["pr", "diff", String(pr.number)], {
        maxBuffer: 64 * 1024 * 1024,
      });
      nums.push(...numbersIn(diff));
    } catch (err) {
      warn(`could not read the diff of PR #${pr.number} (${why(err)})`);
    }
  }
  return nums;
}

function nextNumber(nums: number[]): number {
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

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

function isTracked(root: string, file: string): boolean {
  try {
    git(root, ["ls-files", "--error-unmatch", relPath(file)]);
    return true;
  } catch {
    return false;
  }
}

/** Move a colliding ADR to the next free number: rewrite its header, then git mv (staged). */
export function renumber(root: string, fileArg: string): string {
  const dir = join(root, DECISIONS_DIR);
  const file = fileArg.split("/").pop()!;
  const m = NEW_FILE_RE.exec(file);
  if (!m) {
    throw new Error(`${fileArg}: not a new-style ADR file (ADR-NNN-slug.md)`);
  }
  const n = pad(nextNumber(claimedNumbers(root, file)));
  const target = `ADR-${n}-${m[2]}.md`;
  const before = readFileSync(join(dir, file), "utf8");
  const header = new RegExp(`^## ADR-${m[1]}: `);
  if (!header.test(before)) {
    throw new Error(
      `${relPath(file)}: its first line isn't "## ADR-${m[1]}: …", so the header can't be renumbered. Fix the header first.`,
    );
  }
  writeFileSync(join(dir, file), before.replace(header, `## ADR-${n}: `));
  // A tracked file must move in the index too, or the commit would lose it; surface git's error.
  if (isTracked(root, file)) {
    git(root, ["mv", relPath(file), relPath(target)]);
    git(root, ["add", relPath(target)]); // stage the header rewrite with the move
  } else renameSync(join(dir, file), join(dir, target));
  return relPath(target);
}

export interface Appended {
  id: string;
  title: string;
  content: string;
}

/**
 * What a branch appended to an old-style log. An entry is already recorded if its bytes match a
 * migrated one, or its title matches an ADR file with the same body (a stacked branch whose base
 * PR already imported it under a new number). A title match with a DIFFERENT body is reported in
 * `differs`, never dropped silently: it's an in-place edit of a past entry (not carried over;
 * write a new ADR) or a stale copy of one amended since. Headers that look like an ADR but don't
 * parse are reported in `malformed`, since their text would be glued onto the previous entry.
 */
export function appendedEntries(
  log: string,
  manifest: Manifest,
  known: Map<string, { file: string; text: string }>,
): { entries: Appended[]; differs: string[]; malformed: string[] } {
  const hashes = new Set(manifest.entries.map((e) => e.sha256));
  const bodyOf = (text: string) => text.slice(firstLine(text).length);
  const entries: Appended[] = [];
  const differs: string[] = [];
  for (const c of splitLog(log).chunks) {
    const content = trimSeparator(c.text).content;
    if (hashes.has(sha256(content))) continue;
    const same = known.get(c.title);
    if (!same) {
      entries.push({ id: c.id, title: c.title, content });
    } else if (bodyOf(same.text) !== bodyOf(content)) {
      differs.push(
        `ADR-${c.id} "${c.title}" differs from ${relPath(same.file)}`,
      );
    }
  }
  const malformed = log
    .split("\n")
    .filter((l) => /^#{1,6}\s*ADR\b/i.test(l) && !LEGACY_HEADER_RE.test(l));
  return { entries, differs, malformed };
}

/**
 * Move the ADRs a branch appended to the old docs/DECISIONS.md into their own files.
 * Keeps each entry's number unless it's taken here, else takes the next free one.
 * Throws (writing nothing) on anything it can't carry over faithfully.
 */
export function importFrom(
  root: string,
  ref: string,
): { written: string[]; notes: string[] } {
  const dir = join(root, DECISIONS_DIR);
  const log = git(root, ["show", `${ref}:${LEGACY_LOG}`]);
  if (splitLog(log).chunks.length === 0) {
    throw new Error(
      `${ref}:${LEGACY_LOG} holds no ADR entries (it is already the stub). Pass the commit from before you merged main, e.g. REF=HEAD^1 once the merge is committed.`,
    );
  }
  const manifest = loadManifest(dir);
  const known = new Map(
    loadEntries(dir, manifest).map((e) => [
      e.title,
      { file: e.file, text: e.text },
    ]),
  );
  const { entries, differs, malformed } = appendedEntries(log, manifest, known);
  if (malformed.length) {
    throw new Error(
      `ADR-like headers in ${ref}:${LEGACY_LOG} that don't parse (use "## ADR-NNN: Title"): ${malformed.map((l) => JSON.stringify(l)).join(", ")}. Fix them on your branch and re-run.`,
    );
  }
  const notes = differs.map(
    (d) =>
      `NOT imported: ${d}. If your branch edited a past ADR in place, that edit is not carried over (past ADRs are append-only; write a new ADR). If it's an older copy of an entry amended on main since, nothing is lost.`,
  );
  const written: string[] = [];
  const titles = new Set<string>();
  for (const entry of entries) {
    if (titles.has(entry.title)) continue; // the same entry twice in one log
    titles.add(entry.title);
    const taken = adrFiles(dir).flatMap((f) => numbersIn(f));
    let num = numberOf(entry.id);
    if (taken.includes(num) || !/^\d+$/.test(entry.id)) {
      num = nextNumber([...claimedNumbers(root), ...taken]);
      notes.push(
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
    written.push(relPath(file));
  }
  return { written, notes };
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
      const dir = join(root, DECISIONS_DIR);
      process.stdout.write(renderIndex(loadEntries(dir, loadManifest(dir))));
      return 0;
    }
    case "new": {
      const title = args.join(" ").trim();
      if (!title) {
        console.error('usage: make adr NEW="Short decision title"');
        return 2;
      }
      const num = nextNumber(claimedNumbers(root));
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
      let to: string;
      try {
        to = renumber(root, args[0]);
      } catch (err) {
        console.error(`✗ ${why(err)}`);
        return 1;
      }
      console.log(
        `→ ${to}\nUpdate any references to the old number in your PR (code comments, PR body).`,
      );
      return 0;
    }
    case "import": {
      const ref = args[0] || "HEAD";
      let result: { written: string[]; notes: string[] };
      try {
        result = importFrom(root, ref);
      } catch (err) {
        console.error(`✗ ${why(err)}`);
        return 1;
      }
      for (const n of result.notes) console.warn(`warning: ${n}`);
      if (result.written.length === 0)
        console.log(`no new ADRs in ${ref}:${LEGACY_LOG}`);
      for (const f of result.written) console.log(`wrote ${f}`);
      return 0;
    }
    case "migrate": {
      // Re-run on the latest main before merging the split, so entries appended meanwhile
      // are migrated as legacy too: migrate origin/main --force
      const ref = args.find((a) => !a.startsWith("--")) ?? "HEAD";
      const dir = join(root, DECISIONS_DIR);
      const manifestPath = join(dir, MANIFEST_FILE);
      if (existsSync(manifestPath) && !args.includes("--force")) {
        console.error(
          `✗ ${relPath(MANIFEST_FILE)} exists; the migration already ran. Re-run on purpose with --force.`,
        );
        return 1;
      }
      const commit = git(root, ["rev-parse", ref]).trim();
      const log = git(root, ["show", `${commit}:${LEGACY_LOG}`]);
      const { files, manifest } = migrate(log, commit);
      if (files.size === 0) {
        console.error(
          `✗ ${ref}:${LEGACY_LOG} has no ADR entries (already the stub?); nothing migrated`,
        );
        return 1;
      }
      mkdirSync(dir, { recursive: true });
      if (existsSync(manifestPath)) {
        for (const e of loadManifest(dir).entries)
          rmSync(join(dir, e.file), { force: true });
      }
      for (const [file, content] of files)
        writeFileSync(join(dir, file), content);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(join(root, LEGACY_LOG), LEGACY_STUB);
      console.log(
        `migrated ${files.size} ADRs into ${DECISIONS_DIR}/ (source ${commit.slice(0, 7)})`,
      );
      return 0;
    }
    default:
      console.error(
        "usage: decisions.ts check | index | new <title> | renumber <file> | import [<ref>] | migrate [<ref>] [--force]",
      );
      return 2;
  }
}

// Portable main-guard (see sync-changelog.ts): true as an entrypoint, false on import.
// realpath both sides: invoked via a symlinked path (macOS /tmp → /private/tmp) the URLs differ.
const realHref = (p: string) => {
  try {
    return pathToFileURL(realpathSync(p)).href;
  } catch {
    return pathToFileURL(p).href;
  }
};
if (
  process.argv[1] &&
  realHref(fileURLToPath(import.meta.url)) === realHref(process.argv[1])
) {
  process.exit(main(process.argv.slice(2)));
}
