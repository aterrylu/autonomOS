/**
 * Guard: test suites can never aim git at the real repository.
 *
 * Inside a git hook (the pre-push gate runs `make check`) git exports GIT_DIR —
 * for a linked worktree, `.git/worktrees/<name>`. A fixture that then runs
 * `git init <tmp>` initializes THAT instead and writes core.bare=true into the
 * shared .git/config, breaking the main checkout and every worktree at once
 * (#321; again 2026-10-01 from a statusline fixture). The fix sits at the one
 * shared boundary: `make check` strips git's location variables before any
 * suite runs. These tests keep that boundary from silently disappearing.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./helpers/git-env";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../..");
const LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
];

describe("git environment guard", () => {
  it("suites run with git's location variables stripped", () => {
    const leaked = LOCATION_VARS.filter((k) => process.env[k] !== undefined);
    assert.deepEqual(
      leaked,
      [],
      `${leaked.join(", ")} set in the test env: a fixture git command would act on the real repo. Run the suites via \`make check\` (which strips them).`,
    );
  });

  it("make check strips them for every test recipe", () => {
    const mk = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
    const recipe = mk.slice(mk.indexOf("\ncheck:"));
    const body = recipe.split("\n").slice(2); // skip "" and "check:"
    const end = body.findIndex((l) => !l.startsWith("\t"));
    const testLines = body
      .slice(0, end === -1 ? body.length : end)
      .filter((l) => /--test |vitest run/.test(l));
    assert.equal(testLines.length, 2, "expected the node + vitest test lines");
    for (const l of testLines)
      assert.match(
        l,
        /\$\(GIT_CLEAN_ENV\)/,
        `unguarded test recipe: ${l.trim()}`,
      );
    assert.match(
      mk,
      /GIT_CLEAN_ENV := env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE/,
    );
  });

  it("the repository these tests run in is not bare", () => {
    const bare = execFileSync("git", ["rev-parse", "--is-bare-repository"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: gitEnv(),
    }).trim();
    assert.equal(
      bare,
      "false",
      "core.bare was flipped — a fixture hit the real repo",
    );
  });
});
