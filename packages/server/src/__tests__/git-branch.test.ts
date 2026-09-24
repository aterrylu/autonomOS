/**
 * Provider-neutral agent-row branch (the "project · branch" line). Before this,
 * the branch came only from Claude Code's session JSONL, so Codex/Gemini rows
 * showed the folder with no branch. The branch is now read from `.git` for
 * every agent.
 *
 * Fixtures are built with REAL `git` (init / checkout / worktree add), not
 * hand-written `.git` files — a hand-written fixture only proves the reader
 * agrees with our assumption of git's on-disk format. Git env is scrubbed:
 * inside a git hook GIT_DIR is exported and would aim every fixture call at the
 * outer repo (the core.bare incident).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { AgentDelta, UUID } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-git-branch-${randomUUID()}`;

const { readGitBranch, _resetGitBranchCacheForTesting } = await import(
  "../agents/gitBranch.js"
);
const { enrichAgent } = await import("../agents/enrich.js");
const { refreshGitBranches, _resetGitBranchRefresherForTesting } = await import(
  "../agents/gitBranchRefresher.js"
);
const { buildAgent } = await import("../agents/store.js");
const { onAgentDelta } = await import("../events/agents.js");

function git(cwd: string, ...args: string[]): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf-8", env },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

let root: string;
let repo: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "aos-gitbranch-"));
  repo = join(root, "myproj");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  _resetGitBranchCacheForTesting();
  _resetGitBranchRefresherForTesting();
});

function codexAgentIn(dir: string) {
  return buildAgent({
    id: randomUUID() as UUID,
    name: "codex-worker-a",
    workingDirectory: dir,
    provider: "codex",
    providerSessionId: randomUUID(),
    permissionMode: "ask",
    status: "running",
  });
}

describe("readGitBranch — real git layouts", () => {
  it("reads the checked-out branch of a plain repo", () => {
    assert.equal(readGitBranch(repo), "main");
  });

  it("walks up from a subdirectory to the repo root", () => {
    const sub = join(repo, "packages", "deep");
    mkdirSync(sub, { recursive: true });
    assert.equal(readGitBranch(sub), "main");
  });

  it("keeps slashes in a branch name", () => {
    const r = join(root, "slashy");
    mkdirSync(r);
    git(r, "init", "-q", "-b", "terry/feature-x");
    assert.equal(readGitBranch(r), "terry/feature-x");
  });

  it("a git WORKTREE shows the worktree's own branch, not the main checkout's", () => {
    const wt = join(root, "myproj-wt");
    git(repo, "worktree", "add", "-q", "-b", "terry/wt-branch", wt);
    assert.equal(readGitBranch(wt), "terry/wt-branch");
    assert.equal(readGitBranch(repo), "main", "main checkout unaffected");
  });

  it("a detached HEAD has no branch", () => {
    const d = join(root, "detached");
    mkdirSync(d);
    git(d, "init", "-q", "-b", "main");
    git(d, "commit", "-q", "--allow-empty", "-m", "x");
    git(d, "checkout", "-q", "--detach");
    assert.equal(readGitBranch(d), undefined);
  });

  it("a non-git directory has no branch (and never throws)", () => {
    const plain = join(root, "not-a-repo");
    mkdirSync(plain);
    assert.equal(readGitBranch(plain), undefined);
    assert.equal(readGitBranch(join(root, "does-not-exist")), undefined);
    assert.equal(readGitBranch(undefined), undefined);
  });
});

describe("enrichAgent — every provider gets project · branch", () => {
  it("a CODEX agent in a git repo carries gitBranch", () => {
    assert.equal(enrichAgent(codexAgentIn(repo)).gitBranch, "main");
  });

  it("a CODEX agent in a non-git dir carries no gitBranch (row shows just the folder)", () => {
    const plain = join(root, "plain-folder");
    mkdirSync(plain, { recursive: true });
    assert.equal(enrichAgent(codexAgentIn(plain)).gitBranch, undefined);
  });

  it("enrichment never mutates the record (derived, not persisted)", () => {
    const a = codexAgentIn(repo);
    enrichAgent(a);
    assert.equal(a.gitBranch, undefined);
  });
});

describe("refreshGitBranches — a mid-session checkout reaches the dashboard", () => {
  let seen: AgentDelta[];
  let off: () => void;
  beforeEach(() => {
    seen = [];
    off = onAgentDelta((d) => seen.push(d));
  });
  afterEach(() => off());

  it("first sight records only; a branch change emits ONE version-preserving patch", () => {
    const r = join(root, "switcher");
    mkdirSync(r);
    git(r, "init", "-q", "-b", "main");
    git(r, "commit", "-q", "--allow-empty", "-m", "x");
    const a = codexAgentIn(r);

    refreshGitBranches([a]);
    assert.equal(
      seen.length,
      0,
      "first sight: the snapshot already carried it",
    );

    git(r, "checkout", "-q", "-b", "feature/next");
    refreshGitBranches([a]);
    assert.equal(seen.length, 1);
    const d = seen[0];
    assert.ok(d.type === "agent.updated");
    assert.deepEqual(d.patch, { gitBranch: "feature/next" });
    assert.equal(d.version, a.version, "derived value: version NOT bumped");

    refreshGitBranches([a]);
    assert.equal(seen.length, 1, "no change → no delta");
  });

  it('leaving git (detached) patches the branch to "" so the client can clear it', () => {
    const r = join(root, "detacher");
    mkdirSync(r);
    git(r, "init", "-q", "-b", "main");
    git(r, "commit", "-q", "--allow-empty", "-m", "x");
    const a = codexAgentIn(r);
    refreshGitBranches([a]);
    git(r, "checkout", "-q", "--detach");
    refreshGitBranches([a]);
    const d = seen.at(-1);
    assert.ok(d && d.type === "agent.updated");
    assert.deepEqual(d.patch, { gitBranch: "" });
  });
});
