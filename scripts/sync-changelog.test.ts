// Unit tests for the changelog consolidator. These guard the regression that
// shipped in v0.3.0: the consolidator read only packages/app/CHANGELOG.md, so
// every changeset that didn't list @autonomos/app (server/dashboard/core/cli)
// was silently dropped from the root CHANGELOG and the GitHub Release body.
//
// Everything tested here is pure: per-package CHANGELOGs are gitignored and
// don't exist at test time, and the PR title normally comes from git — so the
// title resolver is injected, and the fs/git shell (main()) is not exercised.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dedupeEntries,
  extractVersionBlock,
  guardDecision,
  isNonEmptyChangeset,
  parseEntries,
  renderSection,
  titleFromSubject,
} from "./sync-changelog.ts";

// A changelog-github per-package CHANGELOG, in changesets' native shape: newest
// version on top as `## X.Y.Z`, entries grouped under `### <Severity> Changes`.
const APP_CHANGELOG = `# @autonomos/app

## 0.4.0

### Patch Changes

- [#208](https://github.com/aterrylu/autonomOS/pull/208) [\`06389b0\`](https://github.com/aterrylu/autonomOS/commit/06389b0) Thanks [@aterrylu](https://github.com/aterrylu)! - Fix statusline in the desktop app.
- [#242](https://github.com/aterrylu/autonomOS/pull/242) [\`01531b8\`](https://github.com/aterrylu/autonomOS/commit/01531b8) Thanks [@aterrylu](https://github.com/aterrylu)! - Per-provider agent icons.

## 0.3.0

### Patch Changes

- [#199](https://github.com/aterrylu/autonomOS/pull/199) [\`abc1234\`](https://github.com/aterrylu/autonomOS/commit/abc1234) Thanks [@aterrylu](https://github.com/aterrylu)! - Old release entry.
`;

// Server-only changes — invisible to the OLD (app-only) consolidator. The whole
// point of the fix is that these now appear in the merged section.
const SERVER_CHANGELOG = `# @autonomos/server

## 0.4.0

### Minor Changes

- [#240](https://github.com/aterrylu/autonomOS/pull/240) [\`7c2f7f2\`](https://github.com/aterrylu/autonomOS/commit/7c2f7f2) Thanks [@aterrylu](https://github.com/aterrylu)! - Stop leaking host env into spawned agents.

### Patch Changes

- [#238](https://github.com/aterrylu/autonomOS/pull/238) [\`1d8b58d\`](https://github.com/aterrylu/autonomOS/commit/1d8b58d) Thanks [@aterrylu](https://github.com/aterrylu)! - Surface launch failures.
`;

// #242 also appears here at a HIGHER severity (Minor) than in app (Patch) — the
// dedup must keep Minor. Models a changeset that lists both app + dashboard.
const DASHBOARD_CHANGELOG = `# @autonomos/dashboard

## 0.4.0

### Minor Changes

- [#242](https://github.com/aterrylu/autonomOS/pull/242) [\`01531b8\`](https://github.com/aterrylu/autonomOS/commit/01531b8) Thanks [@aterrylu](https://github.com/aterrylu)! - Per-provider agent icons.
`;

// Squash-merge subjects keyed by short sha — stands in for `git log -1 %s`.
const SUBJECTS: Record<string, string> = {
  "06389b0": "fix(dashboard): show Codex live status in create-agent panel (#208)",
  "01531b8": "feat(dashboard): per-provider agent icons with settings picker (#242)",
  "7c2f7f2": "fix(server): stop leaking host CLAUDE_CODE_* env into spawned agents (#240)",
  "1d8b58d": "feat(codex): surface outbound channel-server launch failures (#238)",
};
const resolveTitle = (sha: string): string =>
  SUBJECTS[sha] ? titleFromSubject(SUBJECTS[sha]) : "";

// Mirror main()'s merge: parse the current version's block from every package.
function mergeAll(version: string, changelogs: string[]): string {
  const entries = changelogs.flatMap((c) => {
    const block = extractVersionBlock(c, version);
    return block ? parseEntries(block) : [];
  });
  return renderSection(entries, resolveTitle);
}

describe("extractVersionBlock", () => {
  it("grabs the newest matching version block, not an older one", () => {
    const block = extractVersionBlock(APP_CHANGELOG, "0.4.0");
    assert.ok(block);
    assert.match(block, /#208/);
    assert.match(block, /#242/);
    assert.doesNotMatch(block, /#199/); // 0.3.0 entry must not leak in
  });

  it("returns null when the version is absent", () => {
    assert.equal(extractVersionBlock(APP_CHANGELOG, "9.9.9"), null);
  });

  it("tolerates a bracketed heading too", () => {
    const block = extractVersionBlock("\n## [1.2.3] — 2026-01-01\n\nbody\n", "1.2.3");
    assert.ok(block);
    assert.match(block, /body/);
  });
});

describe("parseEntries", () => {
  it("captures pr, sha, and severity per bullet", () => {
    const entries = parseEntries(extractVersionBlock(SERVER_CHANGELOG, "0.4.0")!);
    assert.deepEqual(
      entries.map((e) => ({ pr: e.pr, sha: e.sha, severity: e.severity })),
      [
        { pr: 240, sha: "7c2f7f2", severity: "Minor" },
        { pr: 238, sha: "1d8b58d", severity: "Patch" },
      ],
    );
  });

  it("handles a bullet with no PR link (sha + body only)", () => {
    const block = `
### Patch Changes

- [\`deadbee\`](https://github.com/aterrylu/autonomOS/commit/deadbee) Thanks [@aterrylu](https://github.com/aterrylu)! - Local changeset, no PR.
`;
    const [e] = parseEntries(block);
    assert.equal(e.pr, null);
    assert.equal(e.sha, "deadbee");
    assert.equal(e.body, "Local changeset, no PR.");
  });

  it("does NOT create phantom entries from a body's prose or sub-bullets", () => {
    // A multi-paragraph changeset body whose wrapped lines / list items start
    // with "- " must not be mistaken for new entries — only the signature
    // `- [#NNN]` / `` - [`sha`] `` opening counts.
    const block = `
### Minor Changes

- [#300](https://github.com/aterrylu/autonomOS/pull/300) [\`abcded0\`](https://github.com/aterrylu/autonomOS/commit/abcded0) Thanks [@aterrylu](https://github.com/aterrylu)! - Adds a thing. Also:
  - a sub-bullet
- not really an entry, just prose starting with a dash
`;
    const entries = parseEntries(block);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].pr, 300);
  });

  it("ignores bullets seen before any severity heading (no orphan entries)", () => {
    const block = `
- [#1](https://github.com/aterrylu/autonomOS/pull/1) [\`0000000\`](x) Thanks! - orphan
`;
    assert.deepEqual(parseEntries(block), []);
  });
});

describe("isNonEmptyChangeset", () => {
  it("true when frontmatter declares a package bump", () => {
    assert.equal(
      isNonEmptyChangeset('---\n"@autonomos/server": patch\n---\n\nFix a thing.\n'),
      true,
    );
  });
  it("false for an --empty changeset (no bump lines)", () => {
    assert.equal(isNonEmptyChangeset("---\n---\n\nTrivial, no version impact.\n"), false);
  });
});

describe("dedupeEntries", () => {
  it("collapses a PR seen in multiple packages, keeping highest severity", () => {
    const entries = [
      { pr: 242, sha: "01531b8", body: "icons", severity: "Patch" as const },
      { pr: 242, sha: "01531b8", body: "icons", severity: "Minor" as const },
    ];
    const deduped = dedupeEntries(entries);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].severity, "Minor");
  });
});

describe("titleFromSubject", () => {
  it("strips the trailing (#NNN) GitHub appends", () => {
    assert.equal(
      titleFromSubject("feat(dashboard): per-provider agent icons (#242)"),
      "feat(dashboard): per-provider agent icons",
    );
  });
  it("leaves a subject without a PR suffix untouched", () => {
    assert.equal(titleFromSubject("chore: tidy up"), "chore: tidy up");
  });
});

describe("renderSection (the regression guard)", () => {
  const out = mergeAll("0.4.0", [
    APP_CHANGELOG,
    SERVER_CHANGELOG,
    DASHBOARD_CHANGELOG,
  ]);

  it("includes non-@autonomos/app (server-only) PRs — the core fix", () => {
    assert.match(out, /#240/); // server-only minor
    assert.match(out, /#238/); // server-only patch
  });

  it("renders one concise line per PR, not the changeset body", () => {
    assert.match(
      out,
      /- \[#240\]\(https:\/\/github\.com\/aterrylu\/autonomOS\/pull\/240\) `7c2f7f2` — fix\(server\): stop leaking host CLAUDE_CODE_\* env into spawned agents/,
    );
    // The verbose changeset body must NOT appear.
    assert.doesNotMatch(out, /Stop leaking host env into spawned agents\./);
  });

  it("collapses a multi-package PR (#242) to a single line in the higher section", () => {
    const occurrences = out.match(/#242/g) ?? [];
    assert.equal(occurrences.length, 1);
    // #242 is Minor in dashboard, Patch in app → must land under Minor Changes.
    const minorIdx = out.indexOf("### Minor Changes");
    const patchIdx = out.indexOf("### Patch Changes");
    const pr242Idx = out.indexOf("#242");
    assert.ok(minorIdx >= 0 && pr242Idx > minorIdx);
    assert.ok(patchIdx < 0 || pr242Idx < patchIdx);
  });

  it("orders entries within a section by PR number ascending", () => {
    // Patch section holds #208 and #238 → 208 must precede 238.
    assert.ok(out.indexOf("#208") < out.indexOf("#238"));
  });

  it("puts Minor Changes before Patch Changes", () => {
    assert.ok(out.indexOf("### Minor Changes") < out.indexOf("### Patch Changes"));
  });
});

describe("guardDecision", () => {
  it("ok when the section has content", () => {
    assert.equal(guardDecision("### Patch Changes\n\n- x", 0), "ok");
    assert.equal(guardDecision("### Patch Changes\n\n- x", 3), "ok");
  });
  it("fails on an empty section when changesets were consumed (the bug)", () => {
    assert.equal(guardDecision("", 5), "fail");
  });
  it("warns on an empty section when consumption can't be detected", () => {
    assert.equal(guardDecision("", -1), "warn");
  });
  it("ok on an empty section when nothing was consumed", () => {
    assert.equal(guardDecision("", 0), "ok");
  });
});
