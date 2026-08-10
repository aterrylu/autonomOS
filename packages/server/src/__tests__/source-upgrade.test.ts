// Source-mode upgrade backend (ADR-077 §3) against REAL git repositories:
// a local "origin" with tagged releases, cloned into a managed-clone
// fixture. Only the build command is stubbed (`true`) — a real rebuild
// takes minutes; everything git-side runs for real.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type InstallInfo, readInstallJson } from "../installInfo.js";
import {
  dirtyTrackedFiles,
  getVersionAt,
  latestVersionTag,
  performSourceRollback,
  performSourceUpgrade,
} from "../sourceUpgrade.js";

const STUB_BUILD = ["true"] as const;

let root: string;
let originDir: string;
let cloneDir: string;

function git(cwd: string, ...args: string[]): string {
  // Strip git's context vars: when this suite runs inside a git hook (the
  // pre-push ci-gate), an inherited GIT_DIR would point every fixture git
  // call at the OUTER repository regardless of cwd.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trimEnd();
}

/** Commit a version bump in the origin repo and tag it vX.Y.Z. */
function tagRelease(version: string): void {
  mkdirSync(join(originDir, "packages/server"), { recursive: true });
  writeFileSync(
    join(originDir, "packages/server/package.json"),
    JSON.stringify({ name: "@autonomos/server", version }, null, 2),
  );
  git(originDir, "add", "-A");
  git(originDir, "commit", "-m", `release ${version}`);
  git(originDir, "tag", `v${version}`);
}

function makeInstallInfo(): InstallInfo {
  return { mode: "source", prefix: cloneDir };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autonomos-source-upgrade-"));
  originDir = join(root, "origin");
  cloneDir = join(root, "clone");
  mkdirSync(originDir, { recursive: true });
  git(originDir, "init", "-b", "main");
  git(originDir, "config", "user.email", "test@test");
  git(originDir, "config", "user.name", "test");
  tagRelease("0.1.0");
  git(root, "clone", originDir, cloneDir);
  git(cloneDir, "config", "user.email", "test@test");
  git(cloneDir, "config", "user.name", "test");
  git(cloneDir, "checkout", "v0.1.0");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("performSourceUpgrade", () => {
  it("fetches, checks out the newest tag, rebuilds, records rollback state", async () => {
    tagRelease("0.2.0"); // published to origin AFTER the clone — fetch must find it
    const before = git(cloneDir, "rev-parse", "HEAD");

    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });

    assert.deepEqual(result, {
      status: "upgraded",
      from: "0.1.0",
      to: "0.2.0",
      direction: "upgrade",
    });
    assert.equal(getVersionAt(cloneDir), "0.2.0");
    const marker = readInstallJson(cloneDir);
    assert.equal(marker?.previousRef, before);
    assert.equal(marker?.previousVersion, "0.1.0");
  });

  it("refuses on uncommitted tracked changes, listing the files", async () => {
    writeFileSync(join(cloneDir, "packages/server/package.json"), "{}");
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "error");
    assert.match(
      result.status === "error" ? result.message : "",
      /uncommitted changes[\s\S]*packages\/server\/package.json/,
    );
    // The checkout was not moved.
    assert.equal(git(cloneDir, "describe", "--tags"), "v0.1.0");
  });

  it("restores build-regenerated tracked artifacts instead of refusing on them", async () => {
    // make build rewrites tracked files (channel-server/dist.mjs, bun.lock)
    // in place — after any successful build they can differ byte-wise from
    // the committed artifact. That drift must NOT trip the dirty-tree
    // refusal (it would fire on every run after the first), while any OTHER
    // tracked modification still refuses.
    const artifact = "packages/server/src/channel-server/dist.mjs";
    mkdirSync(join(originDir, "packages/server/src/channel-server"), {
      recursive: true,
    });
    writeFileSync(join(originDir, artifact), "// committed artifact v1\n");
    git(originDir, "add", "-A");
    git(originDir, "commit", "-m", "add build artifact");
    tagRelease("0.2.0");
    git(cloneDir, "fetch", "--tags", "origin");
    git(cloneDir, "checkout", "v0.2.0");

    // Simulate post-build drift in the clone.
    writeFileSync(join(cloneDir, artifact), "// locally rebuilt, differs\n");

    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "upgraded");
    assert.equal(
      readFileSync(join(cloneDir, artifact), "utf-8"),
      "// committed artifact v1\n",
    );
  });

  it("artifact drift plus a REAL tracked edit still refuses, naming only the real edit", async () => {
    const artifact = "packages/server/src/channel-server/dist.mjs";
    mkdirSync(join(originDir, "packages/server/src/channel-server"), {
      recursive: true,
    });
    writeFileSync(join(originDir, artifact), "// committed artifact v1\n");
    writeFileSync(join(originDir, "README.md"), "readme v1\n");
    git(originDir, "add", "-A");
    git(originDir, "commit", "-m", "add artifact + readme");
    tagRelease("0.2.0");
    git(cloneDir, "fetch", "--tags", "origin");
    git(cloneDir, "checkout", "v0.2.0");

    writeFileSync(join(cloneDir, artifact), "// drifted\n"); // exempt
    writeFileSync(join(cloneDir, "README.md"), "hand edit\n"); // NOT exempt

    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "error");
    const message = result.status === "error" ? result.message : "";
    assert.match(message, /README\.md/);
    assert.doesNotMatch(message, /dist\.mjs/);
  });

  it("recovers to the previous commit even when the FAILED build dirtied a tracked artifact", async () => {
    // The failure the revert path must survive: esbuild rewrote dist.mjs,
    // THEN vite failed. Without resetting artifacts before the revert
    // checkout, git refuses ("local changes would be overwritten") and the
    // recovery path is broken by the debris of the failure it recovers from.
    const artifact = "packages/server/src/channel-server/dist.mjs";
    mkdirSync(join(originDir, "packages/server/src/channel-server"), {
      recursive: true,
    });
    writeFileSync(join(originDir, artifact), "// artifact v1\n");
    git(originDir, "add", "-A");
    git(originDir, "commit", "-m", "artifact v1");
    git(originDir, "tag", "-f", "v0.1.0"); // re-tag so the clone's base has it
    tagRelease("0.2.0");
    // Make the artifact CHANGE between the two releases so a dirty copy
    // genuinely conflicts with the revert checkout.
    writeFileSync(join(originDir, artifact), "// artifact v2\n");
    git(originDir, "add", "-A");
    git(originDir, "commit", "-m", "artifact v2");
    git(originDir, "tag", "-f", "v0.2.0");
    git(cloneDir, "fetch", "--tags", "--force", "origin");
    git(cloneDir, "checkout", "v0.1.0");

    const before = git(cloneDir, "rev-parse", "HEAD");
    const dirtyingFailingBuild = [
      "sh",
      "-c",
      `printf '// rewritten by failed build\\n' > ${artifact}; exit 1`,
    ];
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      buildCommand: dirtyingFailingBuild,
    });
    assert.equal(result.status, "error");
    const message = result.status === "error" ? result.message : "";
    assert.match(message, /returned to its previous commit/);
    assert.equal(git(cloneDir, "rev-parse", "HEAD"), before);
  });

  it("gitEnv scrubbing binds: a hostile GIT_DIR in the environment is ignored", async () => {
    // Inside a git hook GIT_DIR is exported and would point every spawned
    // git at the OUTER repo. Set it to the ORIGIN fixture and verify the
    // upgrade still operates on the clone.
    process.env.GIT_DIR = join(originDir, ".git");
    try {
      tagRelease("0.2.0");
      const result = await performSourceUpgrade({
        repoRoot: cloneDir,
        installInfo: makeInstallInfo(),
        currentVersion: "0.1.0",
        buildCommand: STUB_BUILD,
      });
      assert.equal(result.status, "upgraded");
      assert.equal(getVersionAt(cloneDir), "0.2.0");
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it("allows untracked files (build output legitimately sits untracked)", async () => {
    tagRelease("0.2.0");
    writeFileSync(join(cloneDir, "untracked-build-artifact.txt"), "x");
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "upgraded");
  });

  it("reports up-to-date on the newest tag without moving the checkout", async () => {
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });
    assert.deepEqual(result, { status: "up-to-date", version: "0.1.0" });
  });

  it("pins an explicit older tag (downgrade) and says so", async () => {
    tagRelease("0.2.0");
    // Move the clone to 0.2.0 first.
    await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });

    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.2.0",
      targetVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });
    assert.deepEqual(result, {
      status: "upgraded",
      from: "0.2.0",
      to: "0.1.0",
      direction: "downgrade",
    });
    assert.equal(getVersionAt(cloneDir), "0.1.0");
  });

  it("errors on a pinned tag that does not exist", async () => {
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      targetVersion: "3.3.3",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "error");
    assert.match(
      result.status === "error" ? result.message : "",
      /No release tag v3.3.3/,
    );
  });

  it('refuses when the current version is "unknown"', async () => {
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "unknown",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "error");
    assert.match(
      result.status === "error" ? result.message : "",
      /Cannot determine the installed version/,
    );
  });

  it("refuses a repoRoot that is not a git clone", async () => {
    const notARepo = join(root, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    const result = await performSourceUpgrade({
      repoRoot: notARepo,
      installInfo: { mode: "source", prefix: notARepo },
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });
    assert.equal(result.status, "error");
    assert.match(
      result.status === "error" ? result.message : "",
      /not a git clone/,
    );
  });

  it("returns to the previous commit when the build fails (daemon never touched)", async () => {
    tagRelease("0.2.0");
    const before = git(cloneDir, "rev-parse", "HEAD");
    const result = await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: ["false"],
    });
    assert.equal(result.status, "error");
    assert.match(
      result.status === "error" ? result.message : "",
      /Build failed/,
    );
    // Clone is back where it started; no rollback state was recorded.
    assert.equal(git(cloneDir, "rev-parse", "HEAD"), before);
    assert.equal(readInstallJson(cloneDir), null);
  });
});

describe("performSourceRollback", () => {
  it("returns to previousRef and swaps the marker fields (symmetric)", async () => {
    tagRelease("0.2.0");
    await performSourceUpgrade({
      repoRoot: cloneDir,
      installInfo: makeInstallInfo(),
      currentVersion: "0.1.0",
      buildCommand: STUB_BUILD,
    });
    const markerAfterUpgrade = readInstallJson(cloneDir);
    assert.ok(markerAfterUpgrade);

    const back = performSourceRollback(
      cloneDir,
      markerAfterUpgrade,
      STUB_BUILD,
    );
    assert.deepEqual(back, {
      status: "rolled-back",
      from: "0.2.0",
      to: "0.1.0",
    });
    assert.equal(getVersionAt(cloneDir), "0.1.0");

    // Symmetric: rolling back again returns to 0.2.0.
    const markerAfterRollback = readInstallJson(cloneDir);
    assert.ok(markerAfterRollback);
    const forward = performSourceRollback(
      cloneDir,
      markerAfterRollback,
      STUB_BUILD,
    );
    assert.deepEqual(forward, {
      status: "rolled-back",
      from: "0.1.0",
      to: "0.2.0",
    });
    assert.equal(getVersionAt(cloneDir), "0.2.0");
  });

  it("errors when no previous checkout is recorded", () => {
    const result = performSourceRollback(
      cloneDir,
      makeInstallInfo(),
      STUB_BUILD,
    );
    assert.equal(result.status, "error");
    assert.match(
      result.status === "error" ? result.message : "",
      /No previous checkout recorded/,
    );
  });
});

describe("helpers", () => {
  it("latestVersionTag picks the highest semver, numerically", () => {
    tagRelease("0.2.0");
    tagRelease("0.10.0"); // numeric beats lexicographic (0.10 > 0.9-style)
    git(cloneDir, "fetch", "--tags", "origin");
    assert.deepEqual(latestVersionTag(cloneDir), {
      ok: true,
      version: "0.10.0",
    });
  });

  it("dirtyTrackedFiles: tracked modifications listed, untracked excluded", () => {
    writeFileSync(join(cloneDir, "packages/server/package.json"), "{}");
    writeFileSync(join(cloneDir, "untracked.txt"), "x");
    assert.deepEqual(dirtyTrackedFiles(cloneDir), [
      "packages/server/package.json",
    ]);
  });
});
