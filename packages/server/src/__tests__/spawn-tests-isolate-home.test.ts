/**
 * Every in-process test that drives the real spawn path with Claude Code's
 * provider (or one built on it) must run under a throwaway HOME.
 *
 * WHY: claude-code's prepareSpawn pre-trusts the cwd in `.claude.json`,
 * resolved from the child env (a copy of process.env). A test that forgets
 * `isolateHome()` writes a `projects[<tmp cwd>]` key into the operator's REAL
 * ~/.claude.json on every run. That happened with oom-exit-wiring.test.ts
 * (#534): 23 keys, and mcp-auth's real-HOME leak check then failed every
 * pre-push gate on the shared box. On CI the file doesn't exist, so the leak
 * is invisible there; this check is static so it fails everywhere.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const SPAWNS = /\b(?:spawnAgent|restartAgent|respawnAgent)\s*\(/;
const ISOLATED =
  /\bisolateHome\s*\(|helpers\/isolated-home-first\.js|helpers\/test-server\.js/;
/** Anything that can reach claude-code, the DEFAULT provider: naming it, or
 *  building a fake on it. */
const MENTIONS_CLAUDE =
  /\bclaudeCodeProvider\b|providers\/claude-code\.js|["']claude-code["']/;
const REGISTERS_FAKE = /_setProviderForTesting\s*\(/;
/** A fake built on a provider with no pre-trust. */
const NON_CLAUDE_BASE = /\.\.\.(?:codexProvider|geminiProvider)\b/;

/** Inverted (nox, #539): a file that spawns must isolate HOME, unless it
 *  provably runs only non-claude fakes. A test that relies on the DEFAULT
 *  provider and never names it is caught too. */
export function unisolatedSpawnTests(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const src = readFileSync(join(dir, f), "utf-8");
      if (!SPAWNS.test(src) || ISOLATED.test(src)) return false;
      const nonClaudeOnly =
        REGISTERS_FAKE.test(src) &&
        NON_CLAUDE_BASE.test(src) &&
        !MENTIONS_CLAUDE.test(src);
      return !nonClaudeOnly;
    })
    .sort();
}

/** An actual import of the side-effect helper (not a mention in a string). */
const IMPORTS_SIDE_EFFECT_HELPER =
  /^import\s+(?:[^"'\n]*\bfrom\s+)?["']\.\/helpers\/isolated-home-first\.js["']/m;

/** Files that isolate via the side-effect helper but don't import it FIRST:
 *  a later position runs it after shared.ts has captured the real HOME. */
export function lateSideEffectIsolation(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const src = readFileSync(join(dir, f), "utf-8");
      if (!IMPORTS_SIDE_EFFECT_HELPER.test(src)) return false;
      const first = src.match(/^import\b[^\n]*$/m)?.[0] ?? "";
      return first !== 'import "./helpers/isolated-home-first.js";';
    })
    .sort();
}

describe("spawn-path tests never touch the operator's real ~/.claude.json", () => {
  it("every test that spawns isolates HOME, unless it runs only non-claude fakes", () => {
    // Precondition: the scan sees the files it is meant to police.
    const all = readdirSync(here).filter((f) => f.endsWith(".test.ts"));
    assert.ok(
      all.includes("oom-exit-wiring.test.ts") &&
        all.includes("cc-resume-regen-spawn.test.ts"),
      `scanning the wrong directory: ${here}`,
    );
    assert.deepEqual(
      unisolatedSpawnTests(here),
      [],
      "these spawn with claude-code's pre-trust under the REAL HOME; call " +
        "isolateHome() at module top (helpers/isolate-home.ts) before any " +
        "server import",
    );
  });

  it("the side-effect isolation helper is always the FIRST import", () => {
    assert.ok(
      readdirSync(here).some(
        (f) =>
          f.endsWith(".test.ts") &&
          IMPORTS_SIDE_EFFECT_HELPER.test(readFileSync(join(here, f), "utf-8")),
      ),
      "precondition: at least one file uses the side-effect helper",
    );
    assert.deepEqual(lateSideEffectIsolation(here), []);
  });
});
