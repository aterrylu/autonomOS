import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * Tests for configDir.ts — specifically the AUTONOMOS_CONFIG_DIR override.
 *
 * configDir.ts computes CONFIG_DIR at module load time, so these tests
 * can't just flip the env var and re-import. Instead they load the module
 * fresh per test via a cache-busting query string: appending `?test=<uniq>`
 * to the import specifier makes Node's ESM loader treat it as a new module.
 *
 * The safety contract this file enforces (from the silent-failure audit):
 *   - Unset → default to $HOME/.autonomos
 *   - Empty string → THROW (not silently fall through)
 *   - Literal `~/` → expand, not create a `./~` directory
 *   - Relative → resolved against cwd
 *   - Absolute → used verbatim
 */

async function loadFreshConfigDir(env: Record<string, string | undefined>) {
  // Save + restore env so each test is isolated.
  const snapshot = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Cache-bust: query string forces a fresh module evaluation.
    const unique = `${Date.now()}-${Math.random()}`;
    const mod = await import(`../configDir.js?test=${unique}`);
    return mod as typeof import("../configDir.js");
  } finally {
    process.env = snapshot;
  }
}

describe("configDir — AUTONOMOS_CONFIG_DIR override", () => {
  it("defaults to $HOME/.autonomos when override is unset", async () => {
    // Negative control: hard-code HOME so the test doesn't just mirror the
    // runtime env (which would make it tautological).
    const fakeHome = "/tmp/test-home-for-configdir";
    const mod = await loadFreshConfigDir({
      HOME: fakeHome,
      AUTONOMOS_CONFIG_DIR: undefined,
    });
    assert.equal(mod.CONFIG_DIR, join(fakeHome, ".autonomos"));
    assert.equal(mod.IS_OVERRIDDEN_CONFIG_DIR, false);
  });

  it("uses an absolute override verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomos-test-"));
    try {
      const mod = await loadFreshConfigDir({ AUTONOMOS_CONFIG_DIR: dir });
      assert.equal(mod.CONFIG_DIR, dir);
      assert.equal(mod.IS_OVERRIDDEN_CONFIG_DIR, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a relative override against cwd", async () => {
    const mod = await loadFreshConfigDir({
      AUTONOMOS_CONFIG_DIR: ".autonomos-dev",
    });
    assert.ok(isAbsolute(mod.CONFIG_DIR), "resolved path should be absolute");
    assert.equal(mod.CONFIG_DIR, resolve(".autonomos-dev"));
    assert.equal(mod.IS_OVERRIDDEN_CONFIG_DIR, true);
  });

  it("throws on empty-string override instead of silently falling through", async () => {
    // This is the single most dangerous silent-failure mode the module must
    // prevent: `AUTONOMOS_CONFIG_DIR=$UNSET_VAR` expands to "" and would
    // otherwise drop the dev server onto the prod config dir.
    await assert.rejects(
      () => loadFreshConfigDir({ AUTONOMOS_CONFIG_DIR: "" }),
      /empty string/,
    );
  });

  it("expands a literal `~/` prefix using $HOME", async () => {
    // Without this, `AUTONOMOS_CONFIG_DIR=~/.autonomos` (unquoted in some
    // shell contexts) would create a literal `~` directory in cwd.
    const fakeHome = "/tmp/test-home-for-tilde";
    const mod = await loadFreshConfigDir({
      HOME: fakeHome,
      AUTONOMOS_CONFIG_DIR: "~/some/sub/dir",
    });
    assert.equal(mod.CONFIG_DIR, join(fakeHome, "some/sub/dir"));
  });

  it("expands a bare `~` to $HOME", async () => {
    const fakeHome = "/tmp/test-home-bare-tilde";
    const mod = await loadFreshConfigDir({
      HOME: fakeHome,
      AUTONOMOS_CONFIG_DIR: "~",
    });
    assert.equal(mod.CONFIG_DIR, fakeHome);
  });

  it("does NOT expand a bare-tilde-with-username like `~alice`", async () => {
    // Stays as a literal relative path — matches Node's path behavior and
    // avoids trying to resolve other users' home dirs.
    const mod = await loadFreshConfigDir({
      AUTONOMOS_CONFIG_DIR: "~alice/config",
    });
    assert.equal(mod.CONFIG_DIR, resolve("~alice/config"));
  });
});

describe("configDir — ensureConfigDir()", () => {
  it("creates the directory if it does not exist", async () => {
    const parent = mkdtempSync(join(tmpdir(), "autonomos-ensure-"));
    const nested = join(parent, "a", "b", "c");
    try {
      const mod = await loadFreshConfigDir({ AUTONOMOS_CONFIG_DIR: nested });
      assert.equal(existsSync(nested), false, "precondition: dir missing");
      mod.ensureConfigDir();
      assert.equal(existsSync(nested), true, "dir should exist after call");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("is a no-op when the directory already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomos-exists-"));
    try {
      const mod = await loadFreshConfigDir({ AUTONOMOS_CONFIG_DIR: dir });
      assert.doesNotThrow(() => mod.ensureConfigDir());
      assert.equal(existsSync(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error when the path is a file, not a directory", async () => {
    // Point the override at a path whose parent is an existing file — mkdir
    // recursive will fail with ENOTDIR. The wrapped error must name the
    // config dir and AUTONOMOS_CONFIG_DIR so the operator knows what to fix.
    const parent = mkdtempSync(join(tmpdir(), "autonomos-notdir-"));
    const filePath = join(parent, "not-a-dir");
    // Write a regular file at filePath
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "contents");
    const badPath = join(filePath, "sub");
    try {
      const mod = await loadFreshConfigDir({ AUTONOMOS_CONFIG_DIR: badPath });
      assert.throws(
        () => mod.ensureConfigDir(),
        /AUTONOMOS_CONFIG_DIR|config dir/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
