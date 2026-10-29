import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertNoCredentials, findCredentials } from "./hero-credential-guard.js";

/**
 * The README hero capture must run on NO real login (#551). Two guards:
 *  1. its throwaway HOME is checked for credentials (by name and contents);
 *  2. the capture script's source never names the real credential paths or
 *     the keychain read, so the copy can't quietly come back.
 */

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hero-guard-"));
  dirs.push(d);
  return d;
};

describe("hero credential guard", () => {
  it("a clean fake HOME passes (onboarding flags, empty dirs, a transcript)", () => {
    const h = home();
    mkdirSync(join(h, ".claude", "projects"), { recursive: true });
    writeFileSync(join(h, ".claude.json"), '{"hasCompletedOnboarding":true}');
    writeFileSync(join(h, "notes.txt"), "a turn that mentions auth and tokens");
    assert.deepEqual(findCredentials(h), []);
    assert.doesNotThrow(() => assertNoCredentials(h, "fake HOME"));
  });

  it("fails on each CLI's credential file, wherever it lands", () => {
    for (const rel of [
      ".codex/auth.json",
      ".claude/.credentials.json",
      ".gemini/oauth_creds.json",
      ".gemini/google_accounts.json",
      "Library/Keychains/login.keychain-db",
    ]) {
      const h = home();
      mkdirSync(join(h, rel, ".."), { recursive: true });
      writeFileSync(join(h, rel), "{}");
      assert.throws(() => assertNoCredentials(h, "fake HOME"), /credential/, rel);
    }
  });

  it("fails on credential CONTENTS under any name (a renamed copy)", () => {
    for (const body of [
      '{"tokens":{"refresh_token":"x"}}',
      '{"claudeAiOauth":{"accessToken":"y"}}',
      `{"access_token":"${"a".repeat(40)}"}`,
      `token=sk-ant-oat01-${"b".repeat(40)}`,
    ]) {
      const h = home();
      writeFileSync(join(h, "copy.json"), body);
      assert.equal(findCredentials(h).length, 1, body);
    }
  });

  it("doesn't follow symlinks out of the fake HOME (the claude binary link)", () => {
    const h = home();
    const outside = home();
    writeFileSync(join(outside, "auth.json"), '{"refresh_token":"x"}');
    symlinkSync(outside, join(h, "linked"));
    assert.deepEqual(findCredentials(h), []);
  });
});

describe("capture-hero.ts never reads or copies a real credential (#551)", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../packages/dashboard/scripts/capture-hero.ts", import.meta.url),
    ),
    "utf8",
  );
  it("names no real credential path and no keychain read", () => {
    for (const forbidden of [
      /find-generic-password/,
      /["'`]\.credentials\.json["'`]/,
      /["'`]auth\.json["'`]/,
      /["'`]oauth_creds\.json["'`]/,
      /REAL_CODEX_DIR|REAL_GEMINI_DIR|REAL_CLAUDE_CREDS/,
      /homedir\(\)/,
    ])
      assert.ok(!forbidden.test(source), `capture-hero.ts matches ${forbidden}`);
  });
  it("runs the guard on its fake HOME", () => {
    assert.match(source, /assertNoCredentials\(/);
  });
});
