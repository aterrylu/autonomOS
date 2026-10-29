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
const USES_CLAUDE_PROVIDER =
  /\bclaudeCodeProvider\b|providers\/claude-code\.js/;
const ISOLATED = /\bisolateHome\s*\(|helpers\/test-server\.js/;

export function unisolatedSpawnTests(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const src = readFileSync(join(dir, f), "utf-8");
      return (
        SPAWNS.test(src) &&
        USES_CLAUDE_PROVIDER.test(src) &&
        !ISOLATED.test(src)
      );
    })
    .sort();
}

describe("spawn-path tests never touch the operator's real ~/.claude.json", () => {
  it("every test that spawns through the Claude Code provider calls isolateHome()", () => {
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
});
