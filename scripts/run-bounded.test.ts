import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The run that holds the machine-wide test slot must END: a pre-push gate's
 * test runner once idled 48 min at 0% CPU (a test file finished but leaked a
 * live handle) while holding the slot, freezing every agent's push.
 *   - scripts/run-bounded.sh: a whole-run wall-clock bound that stops the
 *     run's entire process group and names the test files still running.
 *   - `make check` runs node --test with --test-force-exit, so a leaked
 *     handle can't keep a finished run alive in the first place.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BOUNDED = join(HERE, "run-bounded.sh");
const TSX = join(ROOT, "packages/server/node_modules/.bin/tsx");

type Run = { code: number | null; out: string; ms: number };

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<Run>((resolve) => {
    const t0 = Date.now();
    // The outer test runner's NODE_TEST_CONTEXT would make an inner
    // `node --test` act as its child instead of running the files.
    const { NODE_TEST_CONTEXT: _c, ...clean } = env;
    const child = spawn(cmd, args, { env: clean, detached: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    const backstop = setTimeout(() => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    }, 30_000);
    child.on("error", (e) => {
      clearTimeout(backstop);
      resolve({ code: -1, out: String(e), ms: Date.now() - t0 });
    });
    child.on("close", (code) => {
      clearTimeout(backstop);
      resolve({ code, out, ms: Date.now() - t0 });
    });
  });
}

const alive = (marker: string) => {
  try {
    execFileSync("pgrep", ["-f", marker], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("scripts/run-bounded.sh", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "run-bounded-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("passes output and exit code through when the run ends in time", async () => {
    const r = await run("bash", [BOUNDED, "10", "bash", "-c", "echo hi; exit 3"]);
    assert.equal(r.code, 3);
    assert.match(r.out, /hi/);
    assert.doesNotMatch(r.out, /run-bounded/);
  });

  it("releases the caller's output the moment the run ends (not at the bound)", async () => {
    // A watchdog sleep left alive held stdout open for the whole bound, so a
    // reader (lefthook) would have waited 25 min after every gate.
    const r = await run("bash", [BOUNDED, "60", "bash", "-c", "echo quick"]);
    assert.equal(r.code, 0);
    assert.ok(r.ms < 5_000, `output stayed open ${r.ms}ms`);
  });

  it("stops the WHOLE process group at the bound, names the stuck test file, exits 124", async () => {
    const marker = `stuck-${process.pid}-${Date.now()}.test.ts`;
    const r = await run("bash", [
      BOUNDED,
      "2",
      "bash",
      "-c",
      `node -e "setInterval(() => {}, 1000)" ${marker} & sleep 600`,
    ]);
    assert.equal(r.code, 124, r.out);
    assert.ok(r.ms < 15_000, `took ${r.ms}ms`);
    assert.match(r.out, /exceeded 2s/);
    assert.match(r.out, new RegExp(marker.replace(/\./g, "\\.")), "names the stuck test");
    assert.match(r.out, /slot is free again/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(alive(marker), false, "no process of the group survives");
  });
});

describe("make check's node runner survives a leaked handle", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "force-exit-"));
    writeFileSync(
      join(dir, "leak.test.mjs"),
      'import { test } from "node:test";\ntest("passes, then leaks", () => { setInterval(() => {}, 1000); });\n',
    );
    writeFileSync(
      join(dir, "ok.test.mjs"),
      'import { test } from "node:test";\ntest("ok", () => {});\n',
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("make check passes --test-force-exit to node --test", () => {
    const mk = readFileSync(join(ROOT, "Makefile"), "utf8");
    assert.match(mk, /NODE_TEST_FORCE_EXIT := --test-force-exit/);
    const line = mk
      .split("\n")
      .find((l) => l.startsWith("\t") && l.includes("--test ") && l.includes("__tests__"));
    assert.ok(line?.includes("$(NODE_TEST_FORCE_EXIT)"), `runner line: ${line}`);
  });

  it("with it, a run whose test leaked a live handle still exits", async () => {
    // Bounded at 20s so a regression fails here, named, instead of hanging.
    const r = await run("bash", [
      BOUNDED,
      "20",
      TSX,
      "--test",
      "--test-force-exit",
      join(dir, "leak.test.mjs"),
      join(dir, "ok.test.mjs"),
    ]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 15_000, `took ${r.ms}ms: ${r.out}`);
  });
});
