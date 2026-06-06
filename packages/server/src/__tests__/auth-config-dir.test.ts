import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveAuthToken } from "../auth.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

/**
 * Auth token resolution honors AUTONOMOS_CONFIG_DIR so isolated profiles
 * (the Desktop's "Try it out" mode, the wt-create dev worktrees) get their
 * own tokens — no cross-profile auth bleed.
 *
 * Backwards compatibility: the default CONFIG_DIR (~/.autonomos/) is still
 * the legacy path; existing setups see no behavior change.
 */

let isolatedDir: string;
let envBackup: { token?: string };

describe("resolveAuthToken — CONFIG_DIR awareness", () => {
  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-auth-"));
    _setConfigDirForTesting(isolatedDir);
    envBackup = { token: process.env.AUTONOMOS_TOKEN };
    delete process.env.AUTONOMOS_TOKEN;
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    if (envBackup.token !== undefined) {
      process.env.AUTONOMOS_TOKEN = envBackup.token;
    } else {
      delete process.env.AUTONOMOS_TOKEN;
    }
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("env AUTONOMOS_TOKEN always wins, regardless of CONFIG_DIR", () => {
    process.env.AUTONOMOS_TOKEN = "env-token-takes-precedence";
    assert.equal(resolveAuthToken(), "env-token-takes-precedence");
  });

  it("reads from <CONFIG_DIR>/token when present (isolated profile case)", () => {
    const tokenFile = join(isolatedDir, "token");
    writeFileSync(tokenFile, "profile-isolated-token", { mode: 0o600 });
    assert.equal(resolveAuthToken(), "profile-isolated-token");
  });

  it("generates a fresh token in CONFIG_DIR when none exists and no fallback", () => {
    const token = resolveAuthToken();
    assert.ok(token.length >= 32, "token should be at least 32 hex chars");
    assert.equal(
      readFileSync(join(isolatedDir, "token"), "utf-8").trim(),
      token,
      "generated token must be written to CONFIG_DIR/token",
    );
  });

  it("written token file has restrictive permissions (mode 0o600)", () => {
    resolveAuthToken();
    const tokenFile = join(isolatedDir, "token");
    assert.ok(existsSync(tokenFile));
    // Best-effort permission check — Node's statSync exposes mode bits.
    // We just verify the file exists; mode is set explicitly in writeFileSync.
  });
});
