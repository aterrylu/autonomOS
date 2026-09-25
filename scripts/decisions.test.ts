// Tests for the one-file-per-ADR layout (scripts/decisions.ts).
//
// Three guarantees are pinned here, all runnable in CI's shallow clone:
//   1. The migration from docs/DECISIONS.md is LOSSLESS: the migrated files,
//      reassembled with the separators the manifest recorded, hash to the original
//      log's sha256, and migrating that rebuilt log again reproduces every file and
//      the manifest exactly. (A full byte diff against `git show` also runs when the
//      source commit is present, i.e. locally.)
//   2. `check` rejects each thing it exists to reject: a duplicate new number, an
//      edited or deleted historical entry, a missing/empty/unfilled required field,
//      a bad date, a filename/header mismatch, any change to the old log's stub, and
//      a stray file in docs/decisions/. Each case runs against a scratch copy of the
//      real tree, so a pass on the unmodified copy proves the failure comes from the
//      mutation alone.
//   3. `renumber` and `import` do what the CI error messages promise, on a real
//      scratch git repo, and refuse (writing nothing) rather than drop content.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  adrFiles,
  appendedEntries,
  checkDecisions,
  DECISIONS_DIR,
  type Entry,
  field,
  importFrom,
  LEGACY_LOG,
  LEGACY_STUB,
  loadEntries,
  loadManifest,
  migrate,
  numbersIn,
  REPO_ROOT,
  reassemble,
  renderIndex,
  renumber,
  sha256,
  slugify,
  supersessions,
  template,
  trimSeparator,
} from "./decisions.ts";

const realDir = join(REPO_ROOT, DECISIONS_DIR);
const manifest = loadManifest(realDir);
const readReal = (f: string) => readFileSync(join(realDir, f), "utf8");
/** The original single-file log, rebuilt from the migrated files (proven by the sha256 test). */
const originalLog = () => reassemble(manifest, readReal);

// renumber/import consult origin/main and open PRs; keep tests off the network.
process.env.ADR_OFFLINE = "1";
// A git hook (the pre-push gate) exports GIT_DIR & co.; scratch repos must not inherit them.
for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"])
  delete process.env[k];

describe("migration from docs/DECISIONS.md is lossless", () => {
  it("reassembles to the recorded sha256 of the original log", () => {
    assert.equal(sha256(originalLog()), manifest.source.sha256);
  });

  it("re-migrating the rebuilt log reproduces every file and the manifest exactly", () => {
    const again = migrate(originalLog(), manifest.source.commit);
    assert.deepEqual(again.manifest, manifest);
    assert.equal(again.files.size, manifest.entries.length);
    for (const [file, content] of again.files)
      assert.equal(readReal(file), content, file);
  });

  it("matches `git show` of the source commit byte for byte (when history is present)", (t) => {
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
        "source commit not in this shallow clone; the two tests above cover it",
      );
      return;
    }
    assert.equal(originalLog(), original);
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

describe("field parsing", () => {
  it("reads bullet, plain and inline (· / —) fields; stops a block at the next field", () => {
    const text = [
      "## ADR-900: X",
      "- **Date:** 2026-09-25 · **Decided by:** Terry",
      "**Context:**",
      "- one",
      "- two",
      "- **Decision:** do it — **Source:** chat",
    ].join("\n");
    assert.deepEqual(field(text, "Date"), {
      inline: "2026-09-25",
      body: "2026-09-25",
    });
    assert.equal(field(text, "Decided by")?.inline, "Terry");
    assert.deepEqual(field(text, "Context"), {
      inline: "",
      body: "- one\n- two",
    });
    assert.equal(field(text, "Decision")?.inline, "do it");
    assert.equal(field(text, "Source")?.inline, "chat");
  });

  it("ignores a label mentioned in prose or shown inside a fenced code block", () => {
    const text =
      "- **Context:** we debated whether a **Decision:** field helps\n```md\n**Rationale:** example\n```\n";
    assert.equal(field(text, "Decision"), undefined);
    assert.equal(field(text, "Rationale"), undefined);
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
  const writeNew = (file: string, text: string) =>
    writeFileSync(join(dir, file), text);

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
    writeNew("ADR-900-a-new-decision.md", filled("900", "A new decision"));
    assert.deepEqual(checkDecisions(root), []);
  });

  it("rejects two new files with the same number, and says how to renumber", () => {
    scratch();
    writeNew("ADR-900-first.md", filled("900", "First"));
    writeNew("ADR-900-second.md", filled("900", "Second"));
    const [err, ...rest] = errorsMatching(/ADR-900 is used by 2 files/);
    assert.equal(rest.length, 0);
    assert.match(err!, /ADR-900-first\.md/);
    assert.match(err!, /ADR-900-second\.md/);
    assert.match(err!, /make adr-renumber FILE=docs\/decisions\/ADR-900-/);
    assert.match(err!, /merges LATER renumbers/);
  });

  it("rejects a new file that reuses a historical number", () => {
    scratch();
    writeNew("ADR-104-reused.md", filled("104", "Reused"));
    assert.equal(errorsMatching(/ADR-104 is used by 2 files/).length, 1);
  });

  it("grandfathers the historical repeat (029 / 029b) but not a new 029", () => {
    scratch();
    assert.deepEqual(errorsMatching(/ADR-029 /), []);
    writeNew("ADR-029-again.md", filled("029", "Again"));
    assert.equal(errorsMatching(/ADR-029 is used by 3 files/).length, 1);
  });

  it("rejects an edit to a historical entry, naming the file", () => {
    scratch();
    const file = manifest.entries[40]!.file;
    writeFileSync(join(dir, file), `${readReal(file)}\nA sneaky amendment.\n`);
    const errs = checkDecisions(root);
    assert.equal(errs.length, 1);
    assert.ok(
      errs[0]!.startsWith(`${DECISIONS_DIR}/${file} was modified`),
      errs[0],
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
      writeNew("ADR-900-missing.md", text);
      assert.deepEqual(checkDecisions(root), [
        `${DECISIONS_DIR}/ADR-900-missing.md: missing required field **${label}:**`,
      ]);
    });
  }

  it("rejects every blank bullet field (the next bullet is not a value)", () => {
    scratch();
    writeNew(
      "ADR-900-blank.md",
      filled("900", "Blank").replace(/^(- \*\*[^*]+:\*\*).*$/gm, "$1"),
    );
    const empty = errorsMatching(/ is empty$/);
    assert.equal(empty.length, 7, empty.join("\n"));
  });

  it("accepts block values, including a one-line block as the last field", () => {
    scratch();
    const text = filled("900", "Block")
      .replace(
        "- **Rationale:** filled in",
        "**Rationale:**\n- one reason\n- another",
      )
      .replace("- **Source:** filled in", "- **Source:**\n  - PR #410");
    writeNew("ADR-900-block.md", text);
    assert.deepEqual(checkDecisions(root), []);
  });

  it("rejects an unfilled template, a TODO inside a block value, and bad dates", () => {
    scratch();
    writeNew("ADR-900-raw.md", template(900, "Raw", "25/09/2026"));
    writeNew(
      "ADR-901-block-todo.md",
      filled("901", "Block todo").replace(
        "- **Context:** filled in",
        "**Context:**\n  TODO later",
      ),
    );
    writeNew(
      "ADR-902-bad-day.md",
      filled("902", "Bad day").replace("2026-09-25", "2026-13-45"),
    );
    const errs = checkDecisions(root);
    assert.equal(
      errs.filter((e) => /ADR-900-raw.*still holds the template's TODO/.test(e))
        .length,
      6,
    );
    assert.equal(
      errs.filter((e) => /ADR-901-block-todo.*Context.*TODO/.test(e)).length,
      1,
    );
    assert.equal(
      errs.filter((e) => /ADR-900-raw.*real YYYY-MM-DD/.test(e)).length,
      1,
    );
    assert.equal(
      errs.filter((e) => /ADR-902-bad-day.*real YYYY-MM-DD/.test(e)).length,
      1,
    );
  });

  it("rejects a field that only appears in prose or in a code block", () => {
    scratch();
    const text = filled("900", "Prose")
      .replace(/^- \*\*Decision:\*\*.*\n/m, "")
      .replace(
        "- **Context:** filled in",
        "- **Context:** should a **Decision:** field exist?\n```\n**Decision:** x\n```",
      );
    writeNew("ADR-900-prose.md", text);
    assert.deepEqual(errorsMatching(/Decision/), [
      `${DECISIONS_DIR}/ADR-900-prose.md: missing required field **Decision:**`,
    ]);
  });

  it("rejects a filename/header mismatch, a bad filename, and a letter suffix on a new file", () => {
    scratch();
    writeNew("ADR-900-mismatch.md", filled("901", "Mismatch"));
    writeNew("adr-902.md", filled("902", "Lowercase"));
    writeNew("ADR-903b-suffixed.md", filled("903", "Suffixed"));
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

  it("rejects a stray file or directory in docs/decisions/", () => {
    scratch();
    writeNew("112-sneaky.md", filled("112", "Sneaky"));
    mkdirSync(join(dir, "drafts"));
    const errs = errorsMatching(/unexpected/);
    assert.equal(errs.length, 2, errs.join("\n"));
  });

  for (const [name, mutate] of [
    [
      "an appended ## ADR entry",
      (s: string) => `${s}\n## ADR-900: Old habit\n`,
    ],
    [
      "an appended ### ADR entry",
      (s: string) => `${s}\n### ADR-900 - Old habit\n`,
    ],
    ["plain prose", (s: string) => `${s}\nWe decided to do X.\n`],
  ] as const) {
    it(`rejects ${name} in the old docs/DECISIONS.md`, () => {
      scratch();
      writeFileSync(join(root, LEGACY_LOG), mutate(LEGACY_STUB));
      const [err, ...rest] = errorsMatching(/docs\/DECISIONS\.md changed/);
      assert.equal(rest.length, 0);
      assert.match(err!, /git checkout origin\/main -- docs\/DECISIONS\.md/);
      if (name.includes("ADR")) assert.match(err!, /make adr-import/);
    });
  }

  it("rejects a deleted docs/DECISIONS.md stub", () => {
    scratch();
    rmSync(join(root, LEGACY_LOG));
    assert.equal(errorsMatching(/docs\/DECISIONS\.md is missing/).length, 1);
  });
});

describe("renumber and import on a scratch git repo", () => {
  let root: string;
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const filled = (num: string, title: string) =>
    template(Number(num), title, "2026-09-25").replace(
      /TODO \([^)]*\)/g,
      "filled in",
    );

  before(() => {
    root = mkdtempSync(join(tmpdir(), "adr-git-"));
    dir = join(root, DECISIONS_DIR);
    cpSync(realDir, dir, { recursive: true });
    writeFileSync(join(root, LEGACY_LOG), LEGACY_STUB);
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("renumber moves a TRACKED colliding file in the index and rewrites its header", () => {
    writeFileSync(join(dir, "ADR-104-collides.md"), filled("104", "Collides"));
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "collide",
    );
    const top = Math.max(...adrFiles(dir).flatMap((f) => numbersIn(f)));
    const to = renumber(root, `${DECISIONS_DIR}/ADR-104-collides.md`);
    const n = String(top + 1).padStart(3, "0");
    assert.equal(to, `${DECISIONS_DIR}/ADR-${n}-collides.md`);
    assert.match(
      readFileSync(join(root, to), "utf8"),
      new RegExp(`^## ADR-${n}: Collides\\n`),
    );
    assert.match(
      git("status", "--porcelain"),
      new RegExp(`R  ${DECISIONS_DIR}/ADR-104-collides.md -> ${to}`),
    );
    assert.deepEqual(checkDecisions(root), []);
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "renumbered",
    );
  });

  it("renumber refuses a file whose header doesn't match its name, changing nothing", () => {
    writeFileSync(join(dir, "ADR-900-mismatch.md"), filled("901", "Mismatch"));
    assert.throws(
      () => renumber(root, `${DECISIONS_DIR}/ADR-900-mismatch.md`),
      /header can't be renumbered/,
    );
    assert.ok(existsSync(join(dir, "ADR-900-mismatch.md")));
    rmSync(join(dir, "ADR-900-mismatch.md"));
  });

  it("import writes a branch's appended entries: a free number is kept, a taken one moves", () => {
    const branchLog = `${originalLog()}\n## ADR-900: Free number\n\n- **Date:** 2026-09-25\nbody\n\n---\n\n## ADR-104: Taken number\nbody\n`;
    writeFileSync(join(root, LEGACY_LOG), branchLog);
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "legacy branch",
    );
    const before = new Set(readdirSync(dir));
    const { written, notes } = importFrom(root, "HEAD");
    const added = readdirSync(dir).filter((f) => !before.has(f));
    assert.equal(written.length, 2);
    assert.ok(added.includes("ADR-900-free-number.md"), added.join());
    assert.equal(
      readFileSync(join(dir, "ADR-900-free-number.md"), "utf8"),
      "## ADR-900: Free number\n\n- **Date:** 2026-09-25\nbody\n",
    );
    const moved = added.find((f) => f.endsWith("-taken-number.md"))!;
    assert.match(moved, /^ADR-901-/); // next after the highest local number (900)
    assert.ok(
      notes.some((n) => /ADR-104 is taken; imported as ADR-901/.test(n)),
      notes.join("\n"),
    );
    for (const f of added) rmSync(join(dir, f));
  });

  it("import refuses the stub, and an unparseable ADR header, writing nothing", () => {
    writeFileSync(join(root, LEGACY_LOG), LEGACY_STUB);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "stub");
    assert.throws(
      () => importFrom(root, "HEAD"),
      /already the stub.*REF=HEAD\^1/,
    );
    writeFileSync(
      join(root, LEGACY_LOG),
      `${originalLog()}\n## ADR 900: Missing dash\nbody\n`,
    );
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "malformed",
    );
    const before = readdirSync(dir).length;
    assert.throws(() => importFrom(root, "HEAD"), /don't parse.*ADR 900/);
    assert.equal(readdirSync(dir).length, before);
  });
});

describe("appendedEntries", () => {
  const known = () =>
    new Map(
      loadEntries(realDir, manifest).map((e) => [
        e.title,
        { file: e.file, text: e.text },
      ]),
    );

  it("skips already-recorded entries (even under a new number), reports in-place edits", () => {
    const e050 = manifest.entries.find((e) => e.id === "050")!;
    const edited = originalLog().replace(
      readReal(e050.file).slice(0, -1),
      `${readReal(e050.file).slice(0, -1)}\nAmended in place.`,
    );
    const k = known();
    // A stacked branch: its base PR already imported this entry under a new number.
    k.set("Imported by the base PR", {
      file: "ADR-120-imported-by-the-base-pr.md",
      text: "## ADR-120: Imported by the base PR\nbody\n",
    });
    const log = `${edited}\n## ADR-104: Imported by the base PR\nbody\n\n## ADR-900: Genuinely new\nbody\n`;
    const { entries, differs, malformed } = appendedEntries(log, manifest, k);
    assert.deepEqual(
      entries.map((e) => [e.id, e.title]),
      [["900", "Genuinely new"]],
    );
    assert.equal(differs.length, 1);
    assert.match(
      differs[0]!,
      /ADR-050 .* differs from docs\/decisions\/ADR-050-/,
    );
    assert.deepEqual(malformed, []);
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

  it("has one row per ADR file in the real tree", () => {
    const rows = renderIndex(loadEntries(realDir, manifest))
      .split("\n")
      .filter((l) => l.startsWith("| [ADR-"));
    assert.equal(rows.length, adrFiles(realDir).length);
  });
});
