/**
 * Projects by git repository (projectResolver.ts): temp classification, git
 * resolution of a WORKTREE to its main repo, persistence (a deleted worktree
 * keeps its repo), and the naming-convention fallback. The git cases run a
 * real `git` against a throwaway repo + worktree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const CFG = mkdtempSync(join(tmpdir(), "aos-projres-cfg-"));
process.env.AUTONOMOS_CONFIG_DIR = CFG;

const {
  _drainProjectResolverForTesting,
  _flushProjectResolverForTesting,
  _learnForTesting,
  _resetProjectResolverForTesting,
  _setTempCheckForTesting,
  _setWorktreesRootForTesting,
  conventionRepo,
  isTempDir,
  repoRootFromCommonDir,
  resolveDir,
} = await import("../projectResolver.js");

after(() => rmSync(CFG, { recursive: true, force: true }));
beforeEach(() => {
  _resetProjectResolverForTesting();
  rmSync(join(CFG, "project-roots.json"), { force: true });
});
afterEach(() => _setTempCheckForTesting(null));

/** git with the env scrubbed of anything that redirects it (a test run under
 *  a hook inherits GIT_DIR — the core.bare incident). */
function git(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete env[k];
  execFileSync("git", ["-C", cwd, ...args], { env, stdio: "ignore" });
}

describe("temp classification (BEFORE git)", () => {
  it("throwaway locations are temp; a workspace is not", () => {
    for (const p of [
      "/tmp/aos-live.Su6K",
      "/private/tmp/x/y",
      "/var/folders/h6/abc/T/foo",
      "/Users/me/.claude/x/scratchpad/y",
      join(tmpdir(), "anything"),
    ])
      assert.equal(isTempDir(p), true, p);
    assert.equal(isTempDir("/Users/me/workspace/autonomOS"), false);
    assert.equal(
      isTempDir("/tmpfoo/bar"),
      false,
      "a prefix, not a directory boundary",
    );
  });
  it("a temp dir is temp even if it's a git repo (resolveDir never asks git)", () => {
    assert.deepEqual(resolveDir("/tmp/aos-oc4-ws", true), { kind: "temp" });
  });
});

describe("repo roots", () => {
  it("--git-common-dir → the repo root (and a bare repo is its own root)", () => {
    assert.equal(repoRootFromCommonDir("/w/autonomOS/.git"), "/w/autonomOS");
    assert.equal(repoRootFromCommonDir("/srv/r.git"), "/srv/r.git");
  });

  it("a WORKTREE resolves to its MAIN repo; learned, persisted, and kept after the worktree is deleted", async () => {
    _setTempCheckForTesting(() => false); // the fixture lives under tmpdir()
    const base = mkdtempSync(join(tmpdir(), "aos-projres-git-"));
    const repo = join(base, "autonomOS");
    const wt = join(base, `autonomOS-terry-${randomUUID().slice(0, 6)}`);
    try {
      git(base, "init", "-q", repo);
      git(
        repo,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      );
      git(repo, "worktree", "add", "-q", wt);

      // First sight: not yet known → a plain dir, queued for git.
      assert.deepEqual(resolveDir(wt, true), { kind: "dir" });
      await _drainProjectResolverForTesting();
      const root = realpathSync(repo);
      assert.deepEqual(resolveDir(wt, true), {
        kind: "repo",
        repoRoot: root,
        resolvedBy: "git",
      });

      _flushProjectResolverForTesting();
      const saved = JSON.parse(
        readFileSync(join(CFG, "project-roots.json"), "utf8"),
      );
      assert.equal(saved[wt], root, "persisted");

      // wt-sync deletes merged worktrees: the repo is REMEMBERED.
      git(repo, "worktree", "remove", "--force", wt);
      assert.equal(existsSync(wt), false);
      _resetProjectResolverForTesting(); // a server restart: reload from disk
      assert.deepEqual(resolveDir(wt, false), {
        kind: "repo",
        repoRoot: root,
        resolvedBy: "learned",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("an existing non-git dir stays a dir", async () => {
    _setTempCheckForTesting(() => false);
    const d = mkdtempSync(join(tmpdir(), "aos-projres-plain-"));
    try {
      resolveDir(d, true);
      await _drainProjectResolverForTesting();
      assert.deepEqual(resolveDir(d, true), { kind: "dir" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("GIT_DIR in the server's env can't redirect the lookup (it would misfile every session)", async () => {
    _setTempCheckForTesting(() => false);
    const base = mkdtempSync(join(tmpdir(), "aos-projres-env-"));
    const a = join(base, "repoA");
    const b = join(base, "repoB");
    const saved = process.env.GIT_DIR;
    try {
      git(base, "init", "-q", a);
      git(base, "init", "-q", b);
      process.env.GIT_DIR = join(b, ".git"); // hostile ambient env
      resolveDir(a, true);
      await _drainProjectResolverForTesting();
      assert.equal(resolveDir(a, true).repoRoot, realpathSync(a));
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("naming-convention fallback (deleted before it was ever seen)", () => {
  const WT = "/h/.claude-worktrees";
  const known = new Map([
    ["/h/workspace/autonomOS", "/h/workspace/autonomOS"],
    ["/h/workspace/autonomOS-cloud", "/h/workspace/autonomOS-cloud"],
  ]);
  it("maps <repo>-<branch> to the KNOWN repo with the LONGEST matching prefix", () => {
    assert.equal(
      conventionRepo(`${WT}/autonomOS-terry-x`, known, WT),
      "/h/workspace/autonomOS",
    );
    assert.equal(
      conventionRepo(`${WT}/autonomOS-cloud-terry-y`, known, WT),
      "/h/workspace/autonomOS-cloud",
      "longest prefix wins",
    );
  });
  it("only under the worktrees root, and only for a repo we know", () => {
    assert.equal(
      conventionRepo("/elsewhere/autonomOS-terry-x", known, WT),
      undefined,
    );
    assert.equal(conventionRepo(`${WT}/other-terry-x`, known, WT), undefined);
    assert.equal(
      conventionRepo(`${WT}/autonomOS`, known, WT),
      undefined,
      "needs <repo>-<branch>",
    );
  });
  it("a learned root elsewhere is not overridden by the convention", () => {
    _learnForTesting(
      "/h/.claude-worktrees/autonomOS-z",
      "/h/elsewhere/autonomOS",
    );
    assert.equal(
      resolveDir("/h/.claude-worktrees/autonomOS-z", false).repoRoot,
      "/h/elsewhere/autonomOS",
    );
  });
});

describe("a worktree HUSK (dir survived, .git gone) still folds into its repo", () => {
  it("git says 'not a repo' under the worktrees root → the naming convention", async () => {
    _setTempCheckForTesting(() => false);
    const root = mkdtempSync(join(tmpdir(), "aos-projres-wtroot-"));
    const husk = join(root, "autonomOS-terry-security-internal-listener");
    mkdirSync(husk);
    _setWorktreesRootForTesting(root);
    try {
      _learnForTesting("/h/workspace/autonomOS", "/h/workspace/autonomOS");
      assert.deepEqual(
        resolveDir(husk, true),
        { kind: "dir" },
        "first sight: queued",
      );
      await _drainProjectResolverForTesting(); // git: not a repository
      assert.deepEqual(resolveDir(husk, true), {
        kind: "repo",
        repoRoot: "/h/workspace/autonomOS",
        resolvedBy: "convention",
      });
    } finally {
      _setWorktreesRootForTesting(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
