/**
 * Fleet harness guards (helpers/fleet-guard.ts): a local fleet test must hold
 * the machine-wide slot and abort itself when the box gets hot.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertFleetSlot,
  defaultLoadLimit,
  startLoadWatchdog,
} from "./helpers/fleet-guard";

describe("assertFleetSlot", () => {
  it("refuses a local run outside the machine-wide slot", () => {
    assert.throws(() => assertFleetSlot({}), /make load-test/);
  });

  it("refuses when holding a DIFFERENT lock", () => {
    assert.throws(() =>
      assertFleetSlot({ AUTONOMOS_GATE_LOCK_HELD: "/tmp/some-other.lock" }),
    );
  });

  it("allows a run inside the slot (default and custom lock path)", () => {
    assertFleetSlot({
      AUTONOMOS_GATE_LOCK_HELD: "/tmp/autonomos-ci-gate.lock",
    });
    assertFleetSlot({
      AUTONOMOS_CI_GATE_LOCK_PATH: "/x/l.lock",
      AUTONOMOS_GATE_LOCK_HELD: "/x/l.lock",
    });
  });

  it("an unusable lock refuses with the real reason (not 'run make load-test')", () => {
    assert.throws(
      () => assertFleetSlot({ AUTONOMOS_GATE_LOCK_HELD: "unlocked" }),
      /lock is unusable/,
    );
  });

  it("an empty lock-path var means the default, like the script", () => {
    assertFleetSlot({
      AUTONOMOS_CI_GATE_LOCK_PATH: "",
      AUTONOMOS_GATE_LOCK_HELD: "/tmp/autonomos-ci-gate.lock",
    });
  });

  it("CI runners are dedicated: no slot needed", () => {
    assertFleetSlot({ CI: "true" });
  });
});

describe("startLoadWatchdog", () => {
  it("aborts once when load passes the limit, then stops", async () => {
    const loads = [3, 5, 50, 60];
    const aborts: number[] = [];
    startLoadWatchdog({
      limit: 40,
      intervalMs: 5,
      read: () => loads.shift() ?? 0,
      onAbort: (l) => aborts.push(l),
      env: {},
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(aborts, [50]);
  });

  it("stays quiet under the limit", async () => {
    let aborted = false;
    const stop = startLoadWatchdog({
      limit: 40,
      intervalMs: 5,
      read: () => 10,
      onAbort: () => {
        aborted = true;
      },
      env: {},
    });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    assert.equal(aborted, false);
  });

  it("is a no-op under CI", async () => {
    let aborted = false;
    startLoadWatchdog({
      limit: 1,
      intervalMs: 5,
      read: () => 999,
      onAbort: () => {
        aborted = true;
      },
      env: { CI: "true" },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(aborted, false);
  });

  it("default limit scales with cores", () => {
    assert.equal(defaultLoadLimit(16), 40);
  });
});

describe("full local runs share the one machine-wide slot", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  // `make -n` still RUNS a recipe line containing $(MAKE) (recursive dry
  // runs), so `check`'s lock wrapper really executes: point it at a private
  // lock that this process "holds", so it passes straight through and never
  // touches the real machine-wide lock.
  const lockDir = mkdtempSync(join(tmpdir(), "slot-dry-"));
  const lock = join(lockDir, "dry.lock");
  after(() => rmSync(lockDir, { recursive: true, force: true }));
  const dry = (target: string, env: NodeJS.ProcessEnv) =>
    execFileSync("make", ["-n", "--no-print-directory", "-C", root, target], {
      encoding: "utf8",
      env: {
        ...env,
        AUTONOMOS_CI_GATE_LOCK_PATH: lock,
        AUTONOMOS_GATE_LOCK_HELD: lock,
      },
    });
  const { CI: _ci, ...noCi } = process.env;

  it("`make check` (incl. integration runs) goes through ci-gate-lock.sh", () => {
    assert.match(
      dry("check", noCi)
        .split("\n")
        .find((l) => l.includes("_check")) ?? "",
      /scripts\/ci-gate-lock\.sh .*_check/,
    );
  });

  it("CI skips the lock (one job per runner)", () => {
    assert.doesNotMatch(
      dry("check", { ...noCi, CI: "true" })
        .split("\n")
        .find((l) => l.includes("_check")) ?? "",
      /ci-gate-lock/,
    );
  });

  it("`make load-test` takes the slot too", () => {
    assert.match(
      dry("load-test", noCi),
      /scripts\/ci-gate-lock\.sh .*AUTONOMOS_LOAD_TEST=1/,
    );
  });
});
