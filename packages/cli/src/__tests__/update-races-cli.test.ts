// Race / timing campaign, job side (ADR-105): the last-moment idle gate, the
// cross-process lock, and the health gate's stability window. Deterministic:
// injected clocks, sleeps and probes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const TEST_DIR = join(tmpdir(), `autonomos-races-cli-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { waitForIdleFleet } = await import("../lib/restart-gate.js");
const { withUpgradeLock } = await import("../lib/status-report.js");
const { verifyDaemonVersion } = await import("../lib/apply-bundle.js");
const { upgradeLockPath } = await import("@autonomos/server/upgradeStatus.js");

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

/** A fake clock whose sleep advances it — no real waiting. */
function fakeTime(startWall = Date.parse("2026-09-24T09:00:00Z")) {
  let t = 0;
  return {
    now: () => t,
    wallNow: () => startWall + t,
    sleep: async (ms: number) => {
      t += ms;
    },
    at: (ms: number) => new Date(startWall + ms).toISOString(),
  };
}

describe("R1: the last-moment idle gate", () => {
  const WINDOW = 30_000;

  it("passes at once when the daemon already reports 30s of idle", async () => {
    const c = fakeTime();
    const r = await waitForIdleFleet({
      readFleet: () => ({ at: c.at(c.now()), idleForMs: 31_000, busy: [] }),
      windowMs: WINDOW,
      capMs: 60_000,
      onWaiting: () => assert.fail("should not wait"),
      ...c,
    });
    assert.deepEqual(r, { ok: true, waitedMs: 0 });
  });

  it("waits while an agent took a turn during the download, then passes", async () => {
    const c = fakeTime();
    const waiting: string[][] = [];
    const r = await waitForIdleFleet({
      // Busy for the first 10s of the gate, then idle; the daemon's
      // continuous-idle counter grows from there.
      readFleet: () => {
        const t = c.now();
        return t < 10_000
          ? {
              at: c.at(t),
              idleForMs: null,
              busy: [{ id: "a", name: "api", status: "working" }],
            }
          : { at: c.at(t), idleForMs: t - 10_000, busy: [] };
      },
      windowMs: WINDOW,
      capMs: 15 * 60_000,
      onWaiting: (busy) => waiting.push(busy.map((b) => b.name)),
      ...c,
    });
    assert.equal(r.ok, true);
    assert.equal(r.waitedMs, 40_000, "10s busy + a full 30s window after");
    assert.deepEqual(waiting[0], ["api"], "reports who it waits for");
  });

  it("gives up at the cap, naming who stayed busy (nothing changed yet)", async () => {
    const c = fakeTime();
    const r = await waitForIdleFleet({
      readFleet: () => ({
        at: c.at(c.now()),
        idleForMs: null,
        busy: [{ id: "a", name: "api", status: "working" }],
      }),
      windowMs: WINDOW,
      capMs: 60_000,
      onWaiting: () => {},
      ...c,
    });
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.deepEqual(
        r.busy.map((b) => b.name),
        ["api"],
      );
  });

  it("a stale or missing report (daemon down) is nothing to wait for", async () => {
    const c = fakeTime();
    for (const readFleet of [
      () => null,
      () => ({ at: c.at(-60_000), idleForMs: null, busy: [] }),
    ]) {
      const r = await waitForIdleFleet({
        readFleet,
        windowMs: WINDOW,
        capMs: 60_000,
        onWaiting: () => assert.fail("should not wait"),
        ...c,
      });
      assert.equal(r.ok, true);
    }
  });
});

describe("R8: withUpgradeLock", () => {
  it("a second concurrent run is refused with the holder named, and the lock is released after", async () => {
    const reports: string[] = [];
    const report = (_p: string, extra?: { message?: string }) => {
      if (extra?.message) reports.push(extra.message);
    };
    let inner = -1;
    const outer = await withUpgradeLock("upgrade", report, async () => {
      inner = await withUpgradeLock("rollback", report, async () => 0);
      return 0;
    });
    assert.equal(outer, 0);
    assert.equal(inner, 1, "refused while the first run holds the lock");
    assert.match(reports[0], /Another update is already running \(pid \d+/);
    // Released: a fresh run gets it.
    assert.equal(await withUpgradeLock("upgrade", report, async () => 7), 7);
    assert.throws(() => readFileSync(upgradeLockPath(TEST_DIR)));
  });

  it("the lock is released even when the run throws", async () => {
    await assert.rejects(
      withUpgradeLock(
        "upgrade",
        () => {},
        async () => {
          throw new Error("boom");
        },
      ),
    );
    assert.equal(
      await withUpgradeLock(
        "upgrade",
        () => {},
        async () => 0,
      ),
      0,
    );
  });

  it("a lock left by a dead process is taken over", async () => {
    writeFileSync(
      upgradeLockPath(TEST_DIR),
      JSON.stringify({ pid: 2 ** 22 + 12345, verb: "upgrade", startedAt: "x" }),
    );
    assert.equal(
      await withUpgradeLock(
        "upgrade",
        () => {},
        async () => 0,
      ),
      0,
    );
  });
});

describe("R10: the health gate wants a STABLE daemon", () => {
  const pidInfo = (pid: number) => ({
    pid,
    port: 1,
    version: "0.8.0",
    startedAt: "2026-09-24T09:00:00Z",
  });

  it("a daemon that answers once and then crash-loops is not healthy", async () => {
    const c = fakeTime();
    let pid = 100;
    const ok = await verifyDaemonVersion("0.8.0", 20_000, {
      stableMs: 10_000,
      deps: {
        // Up for 3s, then a crash-loop restart hands out a new pid each time.
        readPidFile: () => pidInfo(c.now() < 3_000 ? 100 : ++pid),
        isPidAlive: () => true,
        isPortResponsive: async () => true,
        sleep: c.sleep,
        now: c.now,
      },
    });
    assert.equal(ok, false);
  });

  it("the same pid healthy for the whole window passes", async () => {
    const c = fakeTime();
    const ok = await verifyDaemonVersion("0.8.0", 20_000, {
      stableMs: 10_000,
      deps: {
        readPidFile: () => pidInfo(100),
        isPidAlive: () => true,
        isPortResponsive: async () => true,
        sleep: c.sleep,
        now: c.now,
      },
    });
    assert.equal(ok, true);
    assert.ok(c.now() >= 10_000, "held for the window");
  });
});
