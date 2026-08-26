// Auth-continuity contract for the source-install migration (install-source.sh).
//
// THE INVARIANT (Terry, 2026-08-26, after the v0.6.0 forge lockout): an
// upgrade or migration must never change what token the daemon accepts
// without saying so. The v0.6.0 migration dropped the old install tree's
// `.env` — and with it AUTONOMOS_TOKEN — silently 401ing every existing
// browser session. These tests pin the fix: the token is carried, everything
// else is dropped LOUDLY by name, and an untracked `.env` survives the git
// operations the source-upgrade path performs.
//
// The bash under test is exercised for real: the script is `source`d (its
// source-guard exposes migrate_env_from_old_tree without side effects) and
// the function runs against fixture directories. No mocks of bash behavior.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "install-source.sh",
);

type MigrateResult = { stdout: string; stderr: string; status: number };

// The bash under test, for real: source the script (its source-guard stops
// before any side effect) and invoke the migration function directly.
function runMigrateFull(oldTree: string, cloneDir: string): MigrateResult {
  // NOTE: the script path must NOT be passed as $0 — inside a sourced file
  // BASH_SOURCE[0] would then equal $0 and the source-guard would read the
  // source as a direct execution (found the hard way: the arg parser ran
  // and rejected the fixture path).
  const res = spawnSync(
    "bash",
    [
      "-c",
      `source "$1" && migrate_env_from_old_tree "$2" "$3"`,
      "env-migrate-test",
      SCRIPT,
      oldTree,
      cloneDir,
    ],
    { encoding: "utf-8" },
  );
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? 1,
  };
}

function fixture(env?: string): { oldTree: string; cloneDir: string } {
  const root = mkdtempSync(join(tmpdir(), "env-migrate-"));
  const oldTree = join(root, "old-install");
  const cloneDir = join(root, "new-clone");
  mkdirSync(oldTree, { recursive: true });
  mkdirSync(cloneDir, { recursive: true });
  if (env !== undefined) writeFileSync(join(oldTree, ".env"), env);
  return { oldTree, cloneDir };
}

describe("UPGRADES NEVER BREAK EXISTING AUTH (the auth-continuity invariant)", () => {
  it("the exact token that authenticated before the migration authenticates after it", () => {
    // The contract test TeamLead/Terry asked for by name: start from an
    // install whose daemon accepts TOKEN (env layer, priority 1 in
    // auth.ts), migrate, and assert the SAME literal value is what the new
    // install's env layer supplies. If this fails, a user's existing
    // browser session dies on upgrade — that is the incident, do not ship.
    const TOKEN = "pre-migration-token-1234";
    const { oldTree, cloneDir } = fixture(
      `# operator config\nAUTONOMOS_TOKEN=${TOKEN}\n`,
    );

    const res = runMigrateFull(oldTree, cloneDir);
    assert.equal(res.status, 0, res.stderr);

    const migrated = readFileSync(join(cloneDir, ".env"), "utf-8");
    const line = migrated
      .split("\n")
      .find((l) => l.startsWith("AUTONOMOS_TOKEN="));
    assert.equal(
      line,
      `AUTONOMOS_TOKEN=${TOKEN}`,
      "UPGRADE BROKE EXISTING AUTH: the pre-migration token did not survive verbatim",
    );
    assert.match(res.stdout, /token is UNCHANGED/);
  });

  it("carries hostile-but-legal token values verbatim (spaces, quotes, =)", () => {
    const TOKEN = `weird "quoted" = value with spaces`;
    const { oldTree, cloneDir } = fixture(`AUTONOMOS_TOKEN=${TOKEN}\n`);
    const res = runMigrateFull(oldTree, cloneDir);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      readFileSync(join(cloneDir, ".env"), "utf-8").includes(
        `AUTONOMOS_TOKEN=${TOKEN}`,
      ),
    );
  });

  it("the migrated .env is private (0600)", () => {
    const { oldTree, cloneDir } = fixture("AUTONOMOS_TOKEN=secret\n");
    runMigrateFull(oldTree, cloneDir);
    const mode = statSync(join(cloneDir, ".env")).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("non-token overrides are dropped LOUDLY, never silently", () => {
  it("names every dropped key on stderr, values withheld, old file untouched", () => {
    const env =
      "AUTONOMOS_TOKEN=tok\nAUTONOMOS_WS_COALESCE=0\nAUTONOMOS_PERF_ROUTES=1\nSECRET_THING=do-not-print\n";
    const { oldTree, cloneDir } = fixture(env);
    const res = runMigrateFull(oldTree, cloneDir);
    assert.equal(res.status, 0, res.stderr);
    for (const key of [
      "AUTONOMOS_WS_COALESCE",
      "AUTONOMOS_PERF_ROUTES",
      "SECRET_THING",
    ]) {
      assert.ok(res.stderr.includes(key), `dropped key ${key} not named`);
    }
    assert.ok(
      !res.stderr.includes("do-not-print"),
      "dropped VALUES must not be printed",
    );
    const migrated = readFileSync(join(cloneDir, ".env"), "utf-8");
    assert.ok(!migrated.includes("WS_COALESCE"), "dropped key was carried");
    // Restore path intact:
    assert.equal(readFileSync(join(oldTree, ".env"), "utf-8"), env);
  });

  it("a .env WITHOUT a token warns that the login token is about to change", () => {
    const { oldTree, cloneDir } = fixture("AUTONOMOS_WS_COALESCE=0\n");
    const res = runMigrateFull(oldTree, cloneDir);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /login will stop working|token/i);
    assert.ok(
      !existsSync(join(cloneDir, ".env")),
      "no token → no .env fabricated",
    );
  });
});

describe("no-op boundaries (never overwrite, never self-migrate)", () => {
  it("no old .env → clean no-op", () => {
    const { oldTree, cloneDir } = fixture(undefined);
    const res = runMigrateFull(oldTree, cloneDir);
    assert.equal(res.status, 0);
    assert.ok(!existsSync(join(cloneDir, ".env")));
  });

  it("clone already has a .env → left byte-identical", () => {
    const { oldTree, cloneDir } = fixture("AUTONOMOS_TOKEN=old\n");
    writeFileSync(join(cloneDir, ".env"), "AUTONOMOS_TOKEN=mine\n");
    const res = runMigrateFull(oldTree, cloneDir);
    assert.equal(res.status, 0);
    assert.equal(
      readFileSync(join(cloneDir, ".env"), "utf-8"),
      "AUTONOMOS_TOKEN=mine\n",
    );
  });

  it("old tree IS the clone dir (adopt-in-place) → no-op", () => {
    const { oldTree } = fixture("AUTONOMOS_TOKEN=tok\n");
    const res = runMigrateFull(oldTree, oldTree);
    assert.equal(res.status, 0);
    // .env unchanged, no recursion into itself:
    assert.equal(
      readFileSync(join(oldTree, ".env"), "utf-8"),
      "AUTONOMOS_TOKEN=tok\n",
    );
  });
});

describe("source-upgrade path: untracked .env survives git operations (empirical)", () => {
  it(".env survives checkout between tags — verified on a real repo, not reasoned from docs", () => {
    // The audit question: after migration the clone's .env is UNTRACKED.
    // `autonomos upgrade` (sourceUpgrade.ts) runs fetch + `checkout
    // --detach refs/tags/vX` + targeted `checkout --` reverts — none of
    // which may touch untracked files. Prove it on a real git repo with
    // two tags rather than trusting the docs.
    const repo = mkdtempSync(join(tmpdir(), "env-git-"));
    const g = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        } as never,
      });
    g("init", "-q");
    writeFileSync(join(repo, "file.txt"), "v1\n");
    writeFileSync(join(repo, ".gitignore"), ".env\ninstall.json\n");
    g("add", ".");
    g("commit", "-qm", "v1");
    g("tag", "v0.0.1");
    writeFileSync(join(repo, "file.txt"), "v2\n");
    g("add", ".");
    g("commit", "-qm", "v2");
    g("tag", "v0.0.2");

    g("checkout", "-q", "--detach", "refs/tags/v0.0.1");
    writeFileSync(join(repo, ".env"), "AUTONOMOS_TOKEN=survives\n");

    // The upgrade's exact verbs:
    g("checkout", "-q", "--detach", "refs/tags/v0.0.2");
    assert.equal(
      readFileSync(join(repo, ".env"), "utf-8"),
      "AUTONOMOS_TOKEN=survives\n",
      "UPGRADE BROKE EXISTING AUTH: tag checkout removed the untracked .env",
    );
    // The failed-build revert verb (targeted checkout of tracked paths):
    g("checkout", "-q", "refs/tags/v0.0.1", "--", "file.txt");
    assert.equal(
      readFileSync(join(repo, ".env"), "utf-8"),
      "AUTONOMOS_TOKEN=survives\n",
      "UPGRADE BROKE EXISTING AUTH: targeted revert removed the untracked .env",
    );
  });
});
