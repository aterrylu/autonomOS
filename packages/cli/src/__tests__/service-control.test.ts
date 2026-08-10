// restartServiceReloading — the plist-re-reading restart (ADR-080).
//
// Unlike restartService (kickstart, failure-safe: the job keeps running on
// failure), the reloading variant boots the job OUT first, making the
// bootstrap load-bearing: a failure leaves the daemon DOWN. And launchd's
// `bootout` can return before a live process finishes tearing down, so an
// immediate bootstrap fails transiently ("Operation already in progress").
// These tests pin the bounded retry that absorbs that race — and that a
// persistent failure is still reported as a failure, not retried forever.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type InstalledService,
  restartServiceReloading,
} from "../lib/service-control.js";
import type { RunResult } from "../lib/shell.js";

const ok: RunResult = { ok: true, stdout: "", stderr: "", exitCode: 0 };
const fail: RunResult = {
  ok: false,
  stdout: "",
  stderr: "Bootstrap failed: 37: Operation already in progress",
  exitCode: 37,
};

const svc: InstalledService = {
  platform: "darwin",
  serviceFile: "/tmp/fake/com.autonomos.daemon.test.plist",
  uid: 501,
};

/** Scripted runner: bootout gets its own result; each bootstrap consumes the
 * next entry of `bootstrapResults` (last entry repeats). */
function scriptedRun(bootoutResult: RunResult, bootstrapResults: RunResult[]) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let b = 0;
  const runCmd = (cmd: string, args: readonly string[]): RunResult => {
    calls.push([cmd, ...args]);
    if (args[0] === "bootout") return bootoutResult;
    const r = bootstrapResults[Math.min(b, bootstrapResults.length - 1)];
    b++;
    return r;
  };
  return { calls, sleeps, runCmd, sleep: (ms: number) => sleeps.push(ms) };
}

describe("restartServiceReloading (darwin bootout+bootstrap)", () => {
  it("transient bootstrap failure is retried and succeeds", () => {
    const s = scriptedRun(ok, [fail, fail, ok]);
    const result = restartServiceReloading(svc, s);
    assert.equal(result.ok, true);
    const bootstraps = s.calls.filter((c) => c[1] === "bootstrap");
    assert.equal(bootstraps.length, 3);
    assert.deepEqual(s.sleeps, [500, 500]);
  });

  it("persistent bootstrap failure gives up bounded — reported as failure, daemon-down semantics", () => {
    const s = scriptedRun(ok, [fail]);
    const result = restartServiceReloading(svc, s);
    assert.equal(result.ok, false);
    // 1 initial + 5 retries, then stop — never an unbounded loop.
    const bootstraps = s.calls.filter((c) => c[1] === "bootstrap");
    assert.equal(bootstraps.length, 6);
  });

  it("a failed bootout (job not loaded) does not abort — bootstrap still runs and wins", () => {
    const s = scriptedRun(fail, [ok]);
    const result = restartServiceReloading(svc, s);
    assert.equal(result.ok, true);
    assert.equal(s.calls.filter((c) => c[1] === "bootstrap").length, 1);
  });

  it("addresses the job by serviceLabel() — override-aware, never hardcoded", () => {
    process.env.AUTONOMOS_SERVICE_LABEL = "com.autonomos.daemon.test";
    try {
      const s = scriptedRun(ok, [ok]);
      restartServiceReloading(svc, s);
      const bootout = s.calls.find((c) => c[1] === "bootout");
      assert.equal(bootout?.[2], "gui/501/com.autonomos.daemon.test");
    } finally {
      delete process.env.AUTONOMOS_SERVICE_LABEL;
    }
  });
});
