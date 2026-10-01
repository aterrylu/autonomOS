/**
 * The CLI drift verdict CI runs nightly against the INSTALLED CLIs
 * (scripts/check-cli-drift.ts): a CLI update that drops or renames a
 * permission option must fail, naming the option. Here against a fake
 * `claude` on PATH (no real CLI), so this guard runs on every PR.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RUNTIME_PERMISSIONS } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-drift-t-"));
const { checkInstalledClis } = await import("../cliDrift.js");
const { _resetRuntimeProbeCacheForTesting } = await import(
  "../runtimeProbe.js"
);

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TABLE = RUNTIME_PERMISSIONS["claude-code"].axes[0].values.map(
  (v) => v.value,
);

/** A PATH holding only a fake `claude` that accepts `choices`. */
function fakeClaude(choices: string[]): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "aos-drift-bin-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.282 (Claude Code)"; exit 0; fi
if [ "$1" = "--permission-mode" ] && [ "$2" = "__probe__" ]; then
  echo "error: option '--permission-mode <mode>' argument '__probe__' is invalid. Allowed choices are ${choices.join(", ")}." >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  // /bin and /usr/bin for `sh` itself; nothing else named claude/codex/gemini.
  return { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
}

const check = (env: NodeJS.ProcessEnv, required = ["claude-code" as const]) => {
  _resetRuntimeProbeCacheForTesting();
  return checkInstalledClis({ runtimes: ["claude-code"], required, env });
};

describe("checkInstalledClis — the CI drift verdict", () => {
  it("the CLI accepting exactly the table's values: no problems", async () => {
    const r = await check(fakeClaude(TABLE));
    assert.deepEqual(r.problems, []);
    assert.match(r.checked[0], /claude-code: 2\.1\.282/);
  });

  it("a DROPPED option fails, naming it", async () => {
    const r = await check(fakeClaude(TABLE.filter((v) => v !== "dontAsk")));
    assert.equal(r.problems.length, 1, r.problems.join(" | "));
    assert.match(r.problems[0], /permission-mode: no longer accepts dontAsk/);
  });

  it("a RENAMED option fails, naming both the old and the new value", async () => {
    const renamed = TABLE.map((v) => (v === "acceptEdits" ? "acceptAll" : v));
    const r = await check(fakeClaude(renamed));
    const all = r.problems.join(" | ");
    assert.match(all, /no longer accepts acceptEdits/);
    assert.match(all, /now also accepts acceptAll/);
  });

  it("a REQUIRED CLI that isn't installed fails; an optional one is skipped", async () => {
    const empty = { ...process.env, PATH: "/usr/bin:/bin" };
    const r = await check(empty);
    assert.match(r.problems[0], /claude-code: `claude` isn't installed/);
    const opt = await check(empty, []);
    assert.deepEqual(opt.problems, []);
    assert.match(opt.checked[0], /not installed, skipped/);
  });
});
