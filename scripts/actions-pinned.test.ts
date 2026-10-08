import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Security audit H4 (ADR-150): third-party GitHub Actions run with this
 * repo's token (the release workflow's can write releases and sign build
 * provenance). A tag like `@v4` can be moved to any commit by whoever controls
 * the action's repo, so every action is pinned to a full commit SHA, with the
 * release in a trailing comment that Dependabot updates. Every workflow also
 * declares its token permissions in the file.
 */

const WORKFLOWS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

/** Every `uses:` reference of a third-party action (local `./…` excluded). */
function thirdPartyUses(text: string): string[] {
  return [...text.matchAll(/^\s*-?\s*uses:\s*(\S.*)$/gm)]
    .map((m) => m[1].trim())
    .filter((u) => !u.startsWith("./"));
}

describe("GitHub Actions are pinned and least-privilege (audit H4, ADR-150)", () => {
  it("finds the workflows (precondition)", () => {
    assert.ok(files.length >= 5, `only ${files.length} workflows found`);
  });

  for (const f of files) {
    const text = readFileSync(join(WORKFLOWS, f), "utf8");
    it(`${f}: every third-party action is pinned to a commit SHA with its version`, () => {
      for (const u of thirdPartyUses(text)) {
        assert.match(
          u,
          /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/,
          `${f}: "${u}" must be <owner>/<repo>@<40-hex sha> # vX.Y.Z (a tag can be moved under you)`,
        );
      }
    });
    it(`${f}: declares its token permissions`, () => {
      assert.match(
        text,
        /^permissions:/m,
        `${f} has no top-level permissions block, so its token scope comes from a repo setting`,
      );
    });
  }
});
