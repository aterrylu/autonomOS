import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Isolate the config dir before importing anything that resolves it.
const TEST_DIR = join(tmpdir(), `autonomos-status-report-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { makeReporter, statusFileArg, withTerminalStatus } = await import(
  "../lib/status-report.js"
);

/**
 * The out-of-band job's only channel to the dashboard is the status file. A
 * job that throws must still end on a terminal record — otherwise the
 * dashboard follows a run that is gone, forever.
 */

let file: string;
beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  file = join(TEST_DIR, "upgrade-status.json");
  writeFileSync(
    file,
    JSON.stringify({
      phase: "downloading",
      from: "0.7.0",
      to: "0.7.99",
      startedAt: "2026-09-24T00:00:00Z",
      updatedAt: "2026-09-24T00:00:00Z",
    }),
  );
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(file, "utf-8"));

describe("status-report", () => {
  it("parses --status-file", () => {
    assert.equal(statusFileArg(["--status-file=/x/y.json"]), "/x/y.json");
    assert.equal(statusFileArg(["--version=1.2.3"]), undefined);
  });

  it("a job that throws mid-run still ends on a terminal 'failed' record", async () => {
    await assert.rejects(
      withTerminalStatus(file, { kind: "upgrade" }, async () => {
        throw new Error("unsupported platform");
      }),
      /unsupported platform/,
    );
    const rec = read();
    assert.equal(rec.phase, "failed");
    assert.match(
      rec.message,
      /update stopped unexpectedly: unsupported platform/,
    );
    assert.equal(rec.from, "0.7.0", "merged onto the existing record");
  });

  it("never overwrites an outcome the job already recorded", async () => {
    makeReporter(file)("done", { message: "ok" });
    await assert.rejects(
      withTerminalStatus(file, { kind: "upgrade" }, async () => {
        throw new Error("late log failure");
      }),
    );
    assert.equal(read().phase, "done");
  });

  it("a phase's message doesn't leak into the next phase", () => {
    const report = makeReporter(file);
    report("waiting_idle", { message: "Waiting for api to finish" });
    assert.equal(read().message, "Waiting for api to finish");
    report("restarting");
    assert.equal(read().message, undefined);
  });

  it("a rollback job's records carry kind: rollback", () => {
    makeReporter(file, { kind: "rollback" })("restarting");
    assert.equal(read().kind, "rollback");
  });

  it("is a no-op without a status file (shell runs)", async () => {
    makeReporter(undefined)("failed", { message: "x" });
    assert.equal(await withTerminalStatus(undefined, {}, async () => 0), 0);
    assert.equal(read().phase, "downloading");
  });
});
