// Release-tag selection in install-source.sh must only ever pick a tag that is
// on origin/main (security audit V5). A `v*` tag is just a name: anyone with
// push access can put `v9.9.9` on an unreviewed commit, and the installer then
// checks it out and runs its `make prod`.
//
// The bash under test runs for real: the script is sourced (its source-guard
// stops before any side effect) and `pick_release_tag` runs against real git
// fixtures, an "origin" and a clone of it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "install-source.sh",
);

let root: string;
let origin: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  // Strip git's context vars: inside the pre-push hook an inherited GIT_DIR
  // would point every fixture call at the outer repository.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitAndTag(tag: string): void {
  writeFileSync(join(origin, "v.txt"), tag);
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", tag);
  git(origin, "tag", tag);
}

function offMainTag(tag: string): void {
  git(origin, "checkout", "-q", "-b", `side-${tag}`);
  commitAndTag(tag);
  git(origin, "checkout", "-q", "main");
}

/** Run pick_release_tag in the sourced script. The script path must not be
 *  $0, or the source-guard reads it as a direct execution. */
function pick(ref = ""): { out: string; err: string; status: number } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync(
    "bash",
    ["-c", 'source "$1" && pick_release_tag "$2" "$3"', "t", SCRIPT, clone, ref],
    { encoding: "utf-8", env },
  );
  return { out: r.stdout.trim(), err: r.stderr, status: r.status ?? 1 };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-source-tag-"));
  origin = join(root, "origin");
  clone = join(root, "clone");
  git(root, "init", "-q", "-b", "main", origin);
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  commitAndTag("v0.1.0");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install-source.sh pick_release_tag (audit V5)", () => {
  it("defaults to the newest tag ON main, ignoring a higher off-main tag", () => {
    commitAndTag("v0.2.0");
    offMainTag("v9.9.9");
    git(root, "clone", "-q", origin, clone);
    const r = pick();
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "v0.2.0");
  });

  it("refuses an explicit --ref naming an off-main tag", () => {
    offMainTag("v9.9.9");
    git(root, "clone", "-q", origin, clone);
    const r = pick("9.9.9");
    assert.notEqual(r.status, 0);
    assert.equal(r.out, "");
    assert.match(r.err, /v9\.9\.9 is not on origin\/main/);
  });

  it("accepts an explicit --ref on main after main moved on", () => {
    commitAndTag("v0.2.0");
    writeFileSync(join(origin, "later.txt"), "x");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "later");
    git(root, "clone", "-q", origin, clone);
    const r = pick("v0.2.0");
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "v0.2.0");
  });

  it("still rejects a non-tag --ref and a missing tag", () => {
    git(root, "clone", "-q", origin, clone);
    assert.equal(pick("main").status, 64);
    assert.match(pick("v7.7.7").err, /no tag v7\.7\.7/);
  });

  it("fails closed when the clone has no origin/main", () => {
    git(root, "clone", "-q", origin, clone);
    git(clone, "update-ref", "-d", "refs/remotes/origin/main");
    const r = pick();
    assert.notEqual(r.status, 0);
    assert.match(r.err, /origin\/main/);
  });
});
