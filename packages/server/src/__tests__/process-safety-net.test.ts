import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The process-level net under async handlers (audit V6). Run in a child: the
 * oracle is whether the PROCESS survives an unhandled rejection, which the
 * test runner would otherwise intercept itself.
 */

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "processSafetyNet.ts"),
).href;

function runChild(install: boolean) {
  const script = `
    const { installUnhandledRejectionLogger } = await import(${JSON.stringify(MODULE)});
    ${install ? "installUnhandledRejectionLogger();" : ""}
    Promise.reject(new Error("REJECTION_MARKER"));
    setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 200);
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    // `--import tsx` resolves from the cwd; CI runs from the repo root.
    { encoding: "utf8", timeout: 30_000, cwd: SERVER_DIR },
  );
}

describe("installUnhandledRejectionLogger", () => {
  it("control: without it, an unhandled rejection kills the process", () => {
    const r = runChild(false);
    assert.notEqual(r.status, 0);
    assert.ok(!r.stdout.includes("STILL_ALIVE"));
    // It must have died OF the rejection. A child that failed to start at all
    // (e.g. tsx unresolvable) also exits non-zero, and would pass vacuously.
    assert.ok(
      r.stderr.includes("REJECTION_MARKER"),
      `child did not reach the rejection. stderr:\n${r.stderr}`,
    );
  });

  it("with it, the process logs the rejection and keeps running", () => {
    const r = runChild(true);
    assert.equal(r.status, 0, `child exited ${r.status}. stderr:\n${r.stderr}`);
    assert.ok(r.stdout.includes("STILL_ALIVE"));
    assert.ok(
      r.stderr.includes("REJECTION_MARKER"),
      "the rejection must be logged, not swallowed",
    );
  });
});
