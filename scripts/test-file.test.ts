import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * scripts/test-file.sh — the safe way to run one test file ad hoc. A hung
 * test must FAIL and exit under its default timeout (ad-hoc `tsx --test`
 * runs had none, and orphaned hung runs piled up for days), and git's
 * location variables must not reach fixtures (the core.bare flip).
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "test-file.sh");

function run(file: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; out: string; ms: number }>(
    (resolve) => {
      const t0 = Date.now();
      // NODE_TEST_CONTEXT is set by the OUTER test runner; inherited, it makes
      // the inner runner act as its child instead of running the file.
      const { NODE_TEST_CONTEXT: _ctx, ...clean } = env;
      const child = spawn("bash", [SCRIPT, file], {
        env: clean,
        detached: true,
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      // Backstop so a regression (no timeout) fails here instead of hanging.
      const kill = setTimeout(() => {
        try {
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {}
      }, 20_000);
      child.on("close", (code) => {
        clearTimeout(kill);
        resolve({ code, out, ms: Date.now() - t0 });
      });
    },
  );
}

describe("scripts/test-file.sh", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "test-file-"));
    writeFileSync(
      join(dir, "hang.test.mjs"),
      `import { test } from "node:test";
test("never finishes", () => new Promise(() => { setInterval(() => {}, 1000); }));
`,
    );
    writeFileSync(
      join(dir, "env.test.mjs"),
      `import { test } from "node:test";
test("env", () => { console.log("GIT_DIR=" + (process.env.GIT_DIR ?? "<unset>")); });
`,
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("a hung test fails and exits under the default timeout", async () => {
    const r = await run(join(dir, "hang.test.mjs"), {
      ...process.env,
      TEST_TIMEOUT_MS: "1000",
    });
    assert.notEqual(r.code, 0, "a timed-out test must fail the run");
    assert.ok(r.ms < 15_000, `took ${r.ms}ms: no timeout applied`);
    assert.match(r.out, /timed out|cancelled/i);
  });

  it("git's location variables are stripped", async () => {
    const r = await run(join(dir, "env.test.mjs"), {
      ...process.env,
      GIT_DIR: "/somewhere/real/.git",
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /GIT_DIR=<unset>/);
  });
});
