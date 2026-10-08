import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * Security audit H1: Claude Code runs the statusline `command` through a
 * shell, and autonomOS built it as `node ${JSON.stringify(path)}`. JSON
 * quoting only escapes `"` and `\`; inside double quotes the shell still
 * expands `$(...)`, `${...}` and backticks, so an install path containing
 * them ran code on every statusline refresh. The command is now POSIX
 * single-quoted. This runs the real command through `sh`, with a fake `node`
 * that records the argument it receives.
 */

process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-h1-cfg-"));
const { statusLineCommand } = await import("../providers/claude-code.js");
const { shQuote } = await import("../providers/shared.js");

const SANDBOX = mkdtempSync(join(tmpdir(), "aos-h1-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** Run `cmd` with `sh -c`, `node` replaced by a recorder; return what node got. */
function runThroughSh(cmd: string): { arg: string } {
  const out = join(SANDBOX, "arg.txt");
  rmSync(out, { force: true });
  const fakeNode = join(SANDBOX, "node");
  writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`);
  chmodSync(fakeNode, 0o755);
  execFileSync("sh", ["-c", cmd], {
    cwd: SANDBOX,
    env: { PATH: `${SANDBOX}:/usr/bin:/bin` },
  });
  return { arg: readFileSync(out, "utf8") };
}

const canary = join(SANDBOX, "PWNED");
const HOSTILE = [
  `/opt/my apps/autonomOS/statusline.mjs`,
  `/opt/$(touch ${canary})/statusline.mjs`,
  `/opt/\`touch ${canary}\`/statusline.mjs`,
  `/opt/\${HOME}/a"b/statusline.mjs`,
  `/opt/it's/statusline.mjs`,
  `/opt/'; touch ${canary}; '/statusline.mjs`,
];

describe("the statusline command survives a hostile install path (audit H1)", () => {
  for (const path of HOSTILE) {
    it(JSON.stringify(path), () => {
      const { arg } = runThroughSh(statusLineCommand(path));
      assert.equal(arg, path, "node must receive the exact path");
      assert.equal(existsSync(canary), false, "the path ran a command");
    });
  }

  it("shQuote round-trips any string through sh", () => {
    for (const s of [...HOSTILE, "", "plain", "a\nb", "\\", "'''"]) {
      const got = execFileSync("sh", ["-c", `printf '%s' ${shQuote(s)}`], {
        encoding: "utf8",
      });
      assert.equal(got, s);
    }
    assert.equal(existsSync(canary), false);
  });
});
