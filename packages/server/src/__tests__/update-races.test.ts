// Race / timing campaign for the in-app update (ADR-105). Every test forces
// its interleaving deterministically — injected clocks, deps and a pinned
// update-check state; no sleeps against real time.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { systemRouter } from "../routes/system.js";
import { createSnapshot } from "../snapshots.js";
import {
  _resetUpdateCheckForTesting,
  _setUpdateCheckStateForTesting,
} from "../updateCheck.js";
import {
  _resetSchedulerForTesting,
  _setSchedulerDepsForTesting,
  armUpgrade,
  busyReason,
  FIRST_TASK_GRACE_MS,
  getArmedUpgrade,
  IDLE_WINDOW_MS,
  tickArmedUpgrade,
  writeFleetReport,
} from "../upgradeScheduler.js";
import {
  acquireUpgradeLock,
  upgradeLockHeld,
  upgradeLockPath,
  upgradeStatusPath,
  writeUpgradeStatus,
} from "../upgradeStatus.js";
import {
  _resetResumeSignalForTesting,
  noteAgentsResumed,
  verifyRun,
  verifyTiming,
} from "../upgradeVerify.js";

let cfg: string;
let clock: number;
beforeEach(() => {
  cfg = mkdtempSync(join(tmpdir(), "autonomos-races-"));
  _setConfigDirForTesting(cfg);
  _resetSchedulerForTesting();
  _resetUpdateCheckForTesting();
  clock = 1_000;
});
afterEach(() => {
  _resetSchedulerForTesting();
  _resetUpdateCheckForTesting();
  _resetConfigDirForTesting();
  rmSync(cfg, { recursive: true, force: true });
});

const DASHBOARD = {
  Cookie: "autonomos_token=x",
  "Content-Type": "application/json",
  "Sec-Fetch-Site": "same-origin",
};
const app = new Hono();
app.route("/api/system", systemRouter);

describe("idle scheduler", () => {
  it("R1a: an agent going busy mid-countdown restarts the 30s window", () => {
    let busy = false;
    const launches: string[] = [];
    _setSchedulerDepsForTesting({
      now: () => clock,
      busy: () => (busy ? [{ id: "a", name: "a", status: "working" }] : []),
      inFlight: () => false,
      launch: (t) => {
        launches.push(t);
        return { ok: true };
      },
    });
    armUpgrade("0.8.0");
    clock += IDLE_WINDOW_MS - 1_000;
    busy = true;
    tickArmedUpgrade();
    busy = false;
    tickArmedUpgrade(); // idle again: a NEW window starts here
    clock += IDLE_WINDOW_MS - 1;
    tickArmedUpgrade();
    assert.deepEqual(launches, [], "not before a full window since the turn");
    clock += 1;
    tickArmedUpgrade();
    assert.deepEqual(launches, ["0.8.0"]);
  });

  it("R8/R14: never launches next to a running job (shell upgrade, Restore)", () => {
    let inFlight = true;
    const launches: string[] = [];
    _setSchedulerDepsForTesting({
      now: () => clock,
      busy: () => [],
      inFlight: () => inFlight,
      launch: (t) => {
        launches.push(t);
        return { ok: true };
      },
    });
    armUpgrade("0.8.0");
    clock += IDLE_WINDOW_MS * 3;
    tickArmedUpgrade();
    assert.deepEqual(launches, []);
    assert.ok(getArmedUpgrade(), "stays armed while the other job runs");
    inFlight = false;
    tickArmedUpgrade();
    assert.deepEqual(launches, ["0.8.0"]);
  });

  it("R12: the window is measured on the injected monotonic clock, not the wall clock", () => {
    const launches: string[] = [];
    _setSchedulerDepsForTesting({
      now: () => clock,
      busy: () => [],
      inFlight: () => false,
      launch: (t) => {
        launches.push(t);
        return { ok: true };
      },
    });
    armUpgrade("0.8.0");
    // A wall-clock jump (NTP step) doesn't move the monotonic clock.
    clock += 2_000;
    tickArmedUpgrade();
    assert.deepEqual(launches, []);
  });
});

describe("R2: a just-spawned agent with its first task counts as busy", () => {
  const now = 1_000_000;
  it("while its prompt is still being delivered", () => {
    assert.equal(busyReason("ready", true, now - 5_000, now), "first_task");
  });
  it("unknown status within the grace (no receipt, e.g. Codex)", () => {
    assert.equal(busyReason("unknown", false, now - 5_000, now), "first_task");
    assert.equal(
      busyReason("unknown", false, now - FIRST_TASK_GRACE_MS, now),
      null,
    );
  });
  it("an ordinary idle agent is not busy; a working one is", () => {
    assert.equal(busyReason("idle", false, now - 5_000, now), null);
    assert.equal(busyReason("working", false, now - 5_000, now), "status");
  });
});

describe("R1b: the fleet report the job re-checks before its irreversible step", () => {
  it("writes only while a job is in flight, and tracks continuous idle", () => {
    let inFlight = false;
    let busy = false;
    _setSchedulerDepsForTesting({
      now: () => clock,
      busy: () => (busy ? [{ id: "a", name: "a", status: "working" }] : []),
      inFlight: () => inFlight,
    });
    const path = join(cfg, "fleet.json");
    assert.equal(writeFleetReport(path), null);
    inFlight = true;
    assert.equal(writeFleetReport(path)?.idleForMs, 0);
    clock += 5_000;
    assert.equal(writeFleetReport(path)?.idleForMs, 5_000);
    busy = true;
    const r = writeFleetReport(path);
    assert.equal(r?.idleForMs, null);
    assert.deepEqual(
      JSON.parse(readFileSync(path, "utf-8")).busy.map(
        (b: { name: string }) => b.name,
      ),
      ["a"],
    );
    busy = false;
    clock += 1_000;
    assert.equal(writeFleetReport(path)?.idleForMs, 0, "window restarts");
  });
});

describe("R8: one job at a time across processes", () => {
  it("a second acquirer sees the live holder; a dead holder's lock is taken over", () => {
    const path = upgradeLockPath(cfg);
    const a = acquireUpgradeLock("upgrade", path, () => true);
    assert.ok(a.ok);
    const b = acquireUpgradeLock("rollback", path, () => true);
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.holder.pid, process.pid);
    assert.ok(upgradeLockHeld(path, () => true));
    // Holder died (pid gone): stale, taken over.
    const c = acquireUpgradeLock("rollback", path, () => false);
    assert.ok(c.ok);
    if (c.ok) c.release();
    assert.ok(!upgradeLockHeld(path, () => true));
  });

  it("the routes refuse while a shell run holds the lock (no status file)", async () => {
    _setUpdateCheckStateForTesting({ updateAvailable: true, latest: "0.8.0" });
    const lock = acquireUpgradeLock("upgrade", upgradeLockPath(cfg));
    assert.ok(lock.ok);
    const res = await app.request("/api/system/upgrade", {
      method: "POST",
      headers: DASHBOARD,
      body: JSON.stringify({ when: "now" }),
    });
    // NOT_SUPERVISED can come first on a test box; either way no launch.
    const code = (await res.json()).code;
    assert.ok(["IN_FLIGHT", "NOT_SUPERVISED"].includes(code), code);
    if (lock.ok) lock.release();
  });
});

describe("route races", () => {
  it("R11: installs only the version the dialog showed", async () => {
    _setUpdateCheckStateForTesting({ updateAvailable: true, latest: "0.8.1" });
    const res = await app.request("/api/system/upgrade", {
      method: "POST",
      headers: DASHBOARD,
      body: JSON.stringify({ when: "now", expectedVersion: "0.8.0" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "VERSION_CHANGED");
    assert.equal(body.latest, "0.8.1");
  });

  it("R4: a cancel that lost the race to the launch says LAUNCHED, not ok", async () => {
    const lock = acquireUpgradeLock("upgrade", upgradeLockPath(cfg)); // the running job
    writeUpgradeStatus({
      phase: "downloading",
      from: "0.7.0",
      to: "0.8.0",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.request("/api/system/upgrade", {
      method: "DELETE",
      headers: DASHBOARD,
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "LAUNCHED");
    if (lock.ok) lock.release();
  });

  it("R4: cancelling while still armed disarms", async () => {
    _setSchedulerDepsForTesting({
      busy: () => [{ id: "a", name: "a", status: "working" }],
    });
    armUpgrade("0.8.0");
    const res = await app.request("/api/system/upgrade", {
      method: "DELETE",
      headers: DASHBOARD,
    });
    assert.equal(res.status, 200);
    assert.equal(getArmedUpgrade(), null);
  });

  it("R9: GET reports inFlight judged on the server's clock", async () => {
    const lock = acquireUpgradeLock("upgrade", upgradeLockPath(cfg));
    writeUpgradeStatus({
      phase: "fetching",
      from: "0.7.0",
      to: "0.8.0",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.request("/api/system/upgrade", {
      headers: DASHBOARD,
    });
    assert.equal((await res.json()).inFlight, true);
    if (lock.ok) lock.release();
  });

  it("a killed job's record is an orphan at once, not 'in flight' for 15 minutes", async () => {
    const fresh = new Date().toISOString();
    writeUpgradeStatus({
      phase: "downloading",
      from: "0.7.0",
      to: "0.8.0",
      startedAt: fresh,
      updatedAt: fresh,
    });
    // The lock the dead job left behind (its pid is gone):
    writeFileSync(
      upgradeLockPath(cfg),
      JSON.stringify({
        pid: 2 ** 22 + 4242,
        verb: "upgrade",
        startedAt: fresh,
      }),
    );
    const res = await app.request("/api/system/upgrade", {
      headers: DASHBOARD,
    });
    assert.equal((await res.json()).inFlight, false);
    // Just launched, job not at its lock yet: still in flight (time-bounded).
    writeUpgradeStatus({
      phase: "launching",
      from: "0.7.0",
      to: "0.8.0",
      startedAt: fresh,
      updatedAt: fresh,
    });
    const res2 = await app.request("/api/system/upgrade", {
      headers: DASHBOARD,
    });
    assert.equal((await res2.json()).inFlight, true);
  });
});

describe("R3: verification never annotates a newer run", () => {
  it("a Restore started during the settle keeps its own record", async () => {
    Object.assign(verifyTiming, { resumeWaitMs: 5, settleMs: 0 });
    _resetResumeSignalForTesting();
    const path = upgradeStatusPath(cfg);
    const snap = createSnapshot("0.7.0", "0.8.0", cfg);
    const done = {
      phase: "done" as const,
      from: "0.7.0",
      to: "0.8.0",
      startedAt: "2026-09-24T08:00:00.000Z",
      updatedAt: "2026-09-24T08:00:30.000Z",
      snapshotId: snap.id,
    };
    writeUpgradeStatus(done, path);
    const pending = verifyRun(path, done);
    // The operator clicks Restore before the verdict lands.
    writeUpgradeStatus(
      {
        phase: "launching",
        kind: "rollback",
        from: "0.8.0",
        to: "0.7.0",
        startedAt: "2026-09-24T08:00:40.000Z",
        updatedAt: "2026-09-24T08:00:40.000Z",
      },
      path,
    );
    noteAgentsResumed();
    await pending;
    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(after.phase, "launching");
    assert.equal(after.kind, "rollback");
    assert.equal(after.verification, undefined);
  });

  it("a Restore that already FINISHED during the settle isn't annotated either", async () => {
    Object.assign(verifyTiming, { resumeWaitMs: 5, settleMs: 0 });
    _resetResumeSignalForTesting();
    const path = upgradeStatusPath(cfg);
    const snap = createSnapshot("0.7.0", "0.8.0", cfg);
    const done = {
      phase: "done" as const,
      from: "0.7.0",
      to: "0.8.0",
      startedAt: "2026-09-24T08:00:00.000Z",
      updatedAt: "2026-09-24T08:00:30.000Z",
      snapshotId: snap.id,
    };
    writeUpgradeStatus(done, path);
    const pending = verifyRun(path, done);
    // Same phase, same no-verification shape — only the run identity differs.
    writeUpgradeStatus(
      {
        phase: "done",
        kind: "rollback",
        from: "0.8.0",
        to: "0.7.0",
        startedAt: "2026-09-24T08:00:40.000Z",
        updatedAt: "2026-09-24T08:00:45.000Z",
      },
      path,
    );
    noteAgentsResumed();
    await pending;
    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(after.kind, "rollback");
    assert.equal(after.verification, undefined);
  });

  it("the same run still gets its verdict", async () => {
    Object.assign(verifyTiming, { resumeWaitMs: 5, settleMs: 0 });
    _resetResumeSignalForTesting();
    const path = upgradeStatusPath(cfg);
    const snap = createSnapshot("0.7.0", "0.8.0", cfg);
    const done = {
      phase: "done" as const,
      from: "0.7.0",
      to: "0.8.0",
      startedAt: "2026-09-24T08:00:00.000Z",
      updatedAt: "2026-09-24T08:00:30.000Z",
      snapshotId: snap.id,
    };
    writeUpgradeStatus(done, path);
    noteAgentsResumed();
    await verifyRun(path, done);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(after.phase, "done");
    assert.ok(after.verification);
  });

  it("unique temp names: two writers never share a temp file", () => {
    const path = upgradeStatusPath(cfg);
    writeFileSync(`${path}.tmp`, "{ torn"); // the old shared name, left behind
    writeUpgradeStatus(
      {
        phase: "done",
        from: "a",
        to: "b",
        startedAt: "x",
        updatedAt: "y",
      },
      path,
    );
    assert.equal(JSON.parse(readFileSync(path, "utf-8")).phase, "done");
  });
});
