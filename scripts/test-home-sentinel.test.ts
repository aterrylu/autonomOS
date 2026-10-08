import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The home sentinel (test-home-sentinel.ts) must FAIL a test run that changes a
 * watched path's mode, and must not fail one that doesn't. Proven on a
 * throwaway dir via AUTONOMOS_HOME_SENTINEL_PATHS: this test never touches a
 * real home.
 */

const SENTINEL = fileURLToPath(new URL("./test-home-sentinel.ts", import.meta.url));
const TSX = fileURLToPath(
  new URL("../packages/server/node_modules/.bin/tsx", import.meta.url),
);

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function runSuite(body: string): { status: number | null; out: string; watched: string } {
  const work = mkdtempSync(join(tmpdir(), "sentinel-"));
  dirs.push(work);
  // The stand-in for a home folder the sentinel watches: throwaway, 0755.
  const home = mkdtempSync(join(work, "home-"));
  chmodSync(home, 0o755);
  const file = join(work, "probe.test.mjs");
  writeFileSync(
    file,
    `import { test } from "node:test";\nimport { chmodSync } from "node:fs";\ntest("probe", () => { ${body.replace("HOME_DIR", JSON.stringify(home))} });\n`,
  );
  const res = spawnSync(TSX, ["--import", SENTINEL, "--test", file], {
    // Without NODE_TEST_CONTEXT: inherited from this runner, it would make
    // the inner `--test` report to us as a child and always exit 0.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"),
      ),
      AUTONOMOS_HOME_SENTINEL_PATHS: home,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: res.status, out: res.stdout + res.stderr, watched: home };
}

describe("home sentinel", () => {
  it("fails a run whose test changes a watched folder's mode, naming it", () => {
    const r = runSuite("chmodSync(HOME_DIR, 0o700);");
    assert.notEqual(r.status, 0);
    assert.match(r.out, /\[home-sentinel\] a test changed .*: 755 → 700/);
    assert.equal(statSync(r.watched).mode & 0o777, 0o700, "precondition: it did change");
  });

  it("passes a run that leaves it alone", () => {
    const r = runSuite("");
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.out.includes("[home-sentinel]"));
  });
});
