// release.yml's `on-main` gate (security audit V5), executed for real: the
// step's shell is read out of the workflow file itself, so this pins what CI
// actually runs and not a copy of it, and runs against git fixtures standing
// in for the GitHub checkout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
  "release.yml",
);
const STEP_NAME = "Refuse a commit that main does not contain";

/** The `run: |` body of the named step, dedented. */
function stepScript(yml: string, name: string): string {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step "${name}" not found in release.yml`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  assert.ok(runAt > at, `step "${name}" has no run block`);
  const body: string[] = [];
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[runAt + 1]);
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== "" && indent(l) < base) break;
    body.push(l.slice(base));
  }
  return body.join("\n");
}

let root: string;
let origin: string;
let checkout: string;

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, msg: string): string {
  writeFileSync(join(cwd, "f.txt"), msg);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

function runGate(sha: string): { status: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  env.GITHUB_SHA = sha;
  env.GITHUB_REF = "refs/tags/v9.9.9";
  const script = stepScript(readFileSync(WORKFLOW, "utf-8"), STEP_NAME);
  // Actions runs `run:` with bash -e.
  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd: checkout,
    encoding: "utf-8",
    env,
  });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-gate-"));
  origin = join(root, "origin");
  checkout = join(root, "checkout");
  git(root, "init", "-q", "-b", "main", origin);
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  commit(origin, "first");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("release.yml on-main gate (audit V5)", () => {
  it("the publishing job depends on the gate", () => {
    const yml = readFileSync(WORKFLOW, "utf-8");
    const release = yml.slice(yml.indexOf("\n  release:"));
    assert.match(
      release.split("\n").find((l) => l.trim().startsWith("needs:")) ?? "",
      /\bon-main\b/,
    );
  });

  it("passes a commit on main, including after main moved on", () => {
    const tagged = commit(origin, "release");
    commit(origin, "later");
    git(root, "clone", "-q", origin, checkout);
    const r = runGate(tagged);
    assert.equal(r.status, 0, r.out);
  });

  it("fails a commit that main does not contain", () => {
    git(origin, "checkout", "-q", "-b", "side");
    const offMain = commit(origin, "unreviewed");
    git(origin, "checkout", "-q", "main");
    git(root, "clone", "-q", origin, checkout);
    git(checkout, "fetch", "-q", "origin", "side");
    const r = runGate(offMain);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /is not on main/);
  });
});
