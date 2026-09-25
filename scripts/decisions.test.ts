// Tests for the one-file-per-ADR layout (scripts/decisions.ts).
//
// Two guarantees are pinned here:
//   1. The migration from docs/DECISIONS.md is LOSSLESS: the migrated files,
//      reassembled with the separators the manifest recorded, reproduce the old
//      log byte for byte (sha256 always; a full diff too when git history has the
//      source commit, since CI checks out shallow).
//   2. `check` rejects each thing it exists to reject: a duplicate new number, an
//      edited historical entry, a missing required field, an unfilled template, a
//      filename/header mismatch, and a new entry appended to the old log. Each case
//      runs against a scratch copy of the real docs/decisions/, so a pass on the
//      unmodified copy proves the failure comes from the mutation alone.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  appendedEntries,
  checkDecisions,
  DECISIONS_DIR,
  type Entry,
  LEGACY_LOG,
  loadEntries,
  loadManifest,
  migrate,
  numbersIn,
  REPO_ROOT,
  reassemble,
  renderIndex,
  sha256,
  slugify,
  supersessions,
  template,
  trimSeparator,
} from "./decisions.ts";

const realDir = join(REPO_ROOT, DECISIONS_DIR);
const manifest = loadManifest(realDir);
const readReal = (f: string) => readFileSync(join(realDir, f), "utf8");

describe("migration from docs/DECISIONS.md is lossless", () => {
  it("reassembles to the recorded sha256 of the original log", () => {
    const rebuilt = reassemble(manifest, readReal);
    assert.equal(sha256(rebuilt), manifest.source.sha256);
  });

  it("matches the original log byte for byte when git has the source commit", (t) => {
    let original: string;
    try {
      original = execFileSync(
        "git",
        ["-C", REPO_ROOT, "show", `${manifest.source.commit}:${LEGACY_LOG}`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    } catch {
      t.skip(
        "source commit not in this (shallow) clone; the sha256 test above still covers it",
      );
      return;
    }
    assert.equal(reassemble(manifest, readReal), original);
    // And re-running the migration on it reproduces every file and the manifest exactly.
    const again = migrate(original, manifest.source.commit);
    assert.deepEqual(again.manifest, manifest);
    for (const [file, content] of again.files)
      assert.equal(readReal(file), content, file);
  });

  it("keeps historical quirks: order, the repeated 029, the em-dash headers", () => {
    const ids = manifest.entries.map((e) => e.id);
    assert.deepEqual(ids.slice(5, 9), ["006", "009", "007", "008"]); // original, non-numeric order
    const followUp = manifest.entries.find((e) => e.id === "029-follow-up");
    assert.equal(
      followUp?.file,
      "ADR-029b-follow-up-drop-autonomos-deep-link-handler.md",
    );
    assert.match(readReal(followUp!.file), /^## ADR-029-follow-up: /);
    const e073 = manifest.entries.find((e) => e.id === "073")!;
    assert.match(readReal(e073.file), /^## ADR-073 — /);
  });

  it("trimSeparator removes only the trailing separator, and records it", () => {
    const chunk = "## ADR-001: X\nbody\n---\nmid rule stays\n\n---\n\n";
    const { content, tail } = trimSeparator(chunk);
    assert.equal(content, "## ADR-001: X\nbody\n---\nmid rule stays\n");
    assert.equal(content.slice(0, -1) + tail, chunk);
  });
});

describe("check", () => {
  let root: string;
  let dir: string;

  const scratch = () => {
    rmSync(root, { recursive: true, force: true });
    cpSync(realDir, dir, { recursive: true });
    cpSync(join(REPO_ROOT, LEGACY_LOG), join(root, LEGACY_LOG));
  };
  const filled = (num: string, title: string) =>
    template(Number(num), title, "2026-09-25").replace(
      /TODO \([^)]*\)/g,
      "filled in",
    );
  const errorsMatching = (re: RegExp) =>
    checkDecisions(root).filter((e) => re.test(e));

  before(() => {
    root = mkdtempSync(join(tmpdir(), "adr-check-"));
    dir = join(root, DECISIONS_DIR);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("passes on the real tree (baseline for every mutation below)", () => {
    assert.deepEqual(checkDecisions(REPO_ROOT), []);
    scratch();
    assert.deepEqual(checkDecisions(root), []);
  });

  it("accepts a well-formed new entry", () => {
    scratch();
    writeFileSync(
      join(dir, "ADR-900-a-new-decision.md"),
      filled("900", "A new decision"),
    );
    assert.deepEqual(checkDecisions(root), []);
  });

  it("rejects two new files with the same number, and says how to renumber", () => {
    scratch();
    writeFileSync(join(dir, "ADR-900-first.md"), filled("900", "First"));
    writeFileSync(join(dir, "ADR-900-second.md"), filled("900", "Second"));
    const [err, ...rest] = errorsMatching(/ADR-900 is used by 2 files/);
    assert.equal(rest.length, 0);
    assert.match(err!, /ADR-900-first\.md/);
    assert.match(err!, /ADR-900-second\.md/);
    assert.match(err!, /make adr-renumber FILE=docs\/decisions\/ADR-900-/);
    assert.match(err!, /merges LATER renumbers/);
  });

  it("rejects a new file that reuses a historical number", () => {
    scratch();
    writeFileSync(join(dir, "ADR-104-reused.md"), filled("104", "Reused"));
    assert.equal(errorsMatching(/ADR-104 is used by 2 files/).length, 1);
  });

  it("grandfathers the historical repeat (029 / 029b) but not a new 029", () => {
    scratch();
    assert.deepEqual(errorsMatching(/ADR-029 /), []);
    writeFileSync(join(dir, "ADR-029-again.md"), filled("029", "Again"));
    assert.equal(errorsMatching(/ADR-029 is used by 3 files/).length, 1);
  });

  it("rejects an edit to a historical entry, naming the file", () => {
    scratch();
    const file = manifest.entries[40]!.file;
    writeFileSync(join(dir, file), `${readReal(file)}\nA sneaky amendment.\n`);
    const errs = checkDecisions(root);
    assert.equal(errs.length, 1);
    assert.match(
      errs[0]!,
      new RegExp(`${file.replace(".", "\\.")} was modified`),
    );
    assert.match(errs[0]!, /append-only/);
  });

  it("rejects a deleted historical entry", () => {
    scratch();
    rmSync(join(dir, manifest.entries[0]!.file));
    assert.equal(
      errorsMatching(/ADR-001-monorepo-structure\.md is missing/).length,
      1,
    );
  });

  for (const label of [
    "Date",
    "Decided by",
    "Context",
    "Decision",
    "Rationale",
    "Alternatives considered",
    "Source",
  ]) {
    it(`rejects a new entry missing **${label}:**`, () => {
      scratch();
      const text = filled("900", "Missing").replace(
        new RegExp(`^- \\*\\*${label}:\\*\\*.*\\n`, "m"),
        "",
      );
      writeFileSync(join(dir, "ADR-900-missing.md"), text);
      assert.deepEqual(checkDecisions(root), [
        `${DECISIONS_DIR}/ADR-900-missing.md: missing required field **${label}:**`,
      ]);
    });
  }

  it("rejects an unfilled template and a malformed date", () => {
    scratch();
    writeFileSync(
      join(dir, "ADR-900-raw.md"),
      template(900, "Raw", "25/09/2026"),
    );
    const errs = checkDecisions(root);
    assert.equal(
      errs.filter((e) => /still holds the template's TODO/.test(e)).length,
      6,
    );
    assert.equal(
      errs.filter((e) => /\*\*Date:\*\* must start with YYYY-MM-DD/.test(e))
        .length,
      1,
    );
  });

  it("accepts a field whose value is a block on the following lines", () => {
    scratch();
    const text = filled("900", "Block").replace(
      "- **Rationale:** filled in",
      "**Rationale:**\n- one reason\n- another",
    );
    writeFileSync(join(dir, "ADR-900-block.md"), text);
    assert.deepEqual(checkDecisions(root), []);
  });

  it("rejects a filename/header mismatch, a bad filename, and a letter suffix on a new file", () => {
    scratch();
    writeFileSync(join(dir, "ADR-900-mismatch.md"), filled("901", "Mismatch"));
    writeFileSync(join(dir, "adr-902.md"), filled("902", "Lowercase"));
    writeFileSync(join(dir, "ADR-903b-suffixed.md"), filled("903", "Suffixed"));
    const errs = checkDecisions(root);
    assert.equal(
      errs.filter((e) =>
        /header says ADR-901 but the filename says ADR-900/.test(e),
      ).length,
      1,
    );
    assert.equal(
      errs.filter((e) => /adr-902\.md: bad filename/.test(e)).length,
      1,
    );
    assert.equal(
      errs.filter((e) => /ADR-903b-suffixed\.md: bad filename/.test(e)).length,
      1,
    );
  });

  it("rejects a new ADR appended to the old docs/DECISIONS.md", () => {
    scratch();
    writeFileSync(
      join(root, LEGACY_LOG),
      `${readFileSync(join(root, LEGACY_LOG), "utf8")}\n## ADR-900: Old habit\n`,
    );
    const [err, ...rest] = errorsMatching(/gained ADR entries/);
    assert.equal(rest.length, 0);
    assert.match(err!, /ADR-900/);
    assert.match(err!, /make adr-import/);
  });
});

describe("import from a branch that appended to the old log", () => {
  const original = () =>
    execFileSync(
      "git",
      ["-C", REPO_ROOT, "show", `${manifest.source.commit}:${LEGACY_LOG}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );

  it("extracts only the appended entries, including one that reuses a taken number", (t) => {
    let log: string;
    try {
      log = original();
    } catch {
      t.skip("source commit not in this (shallow) clone");
      return;
    }
    // A branch forked before a past entry was amended carries the older copy: not new.
    const e005 = manifest.entries.find((e) => e.id === "005")!;
    const older = readReal(e005.file).replace(
      /\n\*\*Update \(2026-06-29[^\n]*\n/,
      "\n",
    );
    assert.notEqual(
      older,
      readReal(e005.file),
      "fixture: ADR-005 has the amended paragraph",
    );
    const branchLog = log.replace(
      readReal(e005.file).slice(0, -1),
      older.slice(0, -1),
    );
    const appended = `${branchLog}\n---\n\n## ADR-104: Org chart foundation\n\n**Date:** 2026-09-24\nbody\n\n## ADR-112: Something else\nbody\n`;
    const titles = new Set(loadEntries(realDir, manifest).map((e) => e.title));
    // A stacked branch: its base PR already imported this one under a new number.
    titles.add("Imported by the base PR");
    const stacked = `${appended}\n## ADR-104: Imported by the base PR\nbody\n`;
    const found = appendedEntries(stacked, manifest, titles);
    assert.deepEqual(
      found.map((e) => [e.id, e.title]),
      [
        ["104", "Org chart foundation"],
        ["112", "Something else"],
      ],
    );
    assert.equal(
      found[0]!.content,
      "## ADR-104: Org chart foundation\n\n**Date:** 2026-09-24\nbody\n",
    );
  });
});

describe("numbering", () => {
  it("reads numbers from file paths and from +## ADR lines in a diff", () => {
    const text = [
      "docs/decisions/ADR-107-foo.md",
      "docs/decisions/ADR-029b-follow-up-x.md",
      "docs/decisions/README.md",
      "+## ADR-110: Rich inspector",
      " ## ADR-050: context line, not an addition",
    ].join("\n");
    assert.deepEqual(
      numbersIn(text).sort((a, b) => a - b),
      [29, 107, 110],
    );
  });

  it("slugify makes stable kebab slugs", () => {
    assert.equal(
      slugify("`selectUsageOrg()` heuristic — pick `chat`!"),
      "selectusageorg-heuristic-pick-chat",
    );
    assert.ok(slugify("word ".repeat(40)).length <= 60);
  });
});

describe("index", () => {
  const entry = (id: string, title: string, text = ""): Entry => ({
    file: `ADR-${id}-x.md`,
    id,
    num: Number.parseInt(id, 10),
    title,
    text: `## ADR-${id}: ${title}\n- **Date:** 2026-09-25\n${text}`,
    legacy: false,
  });

  it("parses supersession from titles and the Supersedes field; X's means in part", () => {
    assert.deepEqual(
      supersessions(entry("059", "Remove it (supersedes ADR-018)")),
      [{ target: "018", partial: false }],
    );
    assert.deepEqual(
      supersessions(entry("111", "Fix (supersedes ADR-049's fresh start)")),
      [{ target: "049", partial: true }],
    );
    assert.deepEqual(
      supersessions(entry("029", "Embed (Reverses Part of ADR-028)")),
      [{ target: "028", partial: true }],
    );
    assert.deepEqual(
      supersessions(
        entry(
          "048",
          "OAuth",
          "- **Supersedes:** ADR-046 (scan) and the lineage of ADR-041\n",
        ),
      ),
      [{ target: "046", partial: false }],
    );
  });

  it("renders status, both supersession columns, escapes pipes, and sorts numerically", () => {
    const out = renderIndex([
      entry("120", "Newer (supersedes ADR-018)"),
      entry("018", "Old | piped"),
      entry("121", "Explicit", "- **Status:** Proposed\n"),
    ]);
    const rows = out.split("\n").filter((l) => l.startsWith("| [ADR-"));
    assert.deepEqual(rows, [
      "| [ADR-018](ADR-018-x.md) | Old \\| piped | 2026-09-25 | Superseded by ADR-120 |  | ADR-120 |",
      "| [ADR-120](ADR-120-x.md) | Newer (supersedes ADR-018) | 2026-09-25 | Accepted | ADR-018 |  |",
      "| [ADR-121](ADR-121-x.md) | Explicit | 2026-09-25 | Proposed |  |  |",
    ]);
  });

  it("covers every ADR file in the real tree", () => {
    const entries = loadEntries(realDir, manifest);
    assert.equal(
      entries.length,
      manifest.entries.length + entries.filter((e) => !e.legacy).length,
    );
    const rows = renderIndex(entries)
      .split("\n")
      .filter((l) => l.startsWith("| [ADR-"));
    assert.equal(rows.length, entries.length);
  });
});
