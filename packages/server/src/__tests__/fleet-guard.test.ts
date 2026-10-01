/**
 * Fleet harness guards (helpers/fleet-guard.ts): a local fleet test must hold
 * the machine-wide slot and abort itself when the box gets hot.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
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
  // Virtual time: the watchdog's setInterval is mocked and advanced by hand,
  // so these never depend on real timer scheduling (a real 5ms interval in a
  // 60ms window flaked under a loaded pre-push gate: fewer ticks fired).
  beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
  afterEach(() => mock.timers.reset());

  it("aborts once when load passes the limit, then stops", () => {
    const loads = [3, 5, 50, 60];
    let reads = 0;
    const aborts: number[] = [];
    startLoadWatchdog({
      limit: 40,
      intervalMs: 5,
      read: () => {
        reads++;
        return loads.shift() ?? 0;
      },
      onAbort: (l) => aborts.push(l),
      env: {},
    });
    mock.timers.tick(5 * 10); // 10 intervals
    assert.deepEqual(aborts, [50]);
    assert.equal(reads, 3, "stopped sampling after the abort");
  });

  it("stays quiet under the limit", () => {
    let reads = 0;
    let aborted = false;
    const stop = startLoadWatchdog({
      limit: 40,
      intervalMs: 5,
      read: () => {
        reads++;
        return 10;
      },
      onAbort: () => {
        aborted = true;
      },
      env: {},
    });
    mock.timers.tick(5 * 8);
    stop();
    assert.equal(reads, 8, "precondition: it really sampled");
    assert.equal(aborted, false);
  });

  it("is a no-op under CI", () => {
    let reads = 0;
    startLoadWatchdog({
      limit: 1,
      intervalMs: 5,
      read: () => {
        reads++;
        return 999;
      },
      onAbort: () => assert.fail("must not abort under CI"),
      env: { CI: "true" },
    });
    mock.timers.tick(5 * 8);
    assert.equal(reads, 0, "no sampling at all under CI");
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
