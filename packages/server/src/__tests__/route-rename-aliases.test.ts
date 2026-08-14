import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * PR C route renames — the ONE-RELEASE compat aliases.
 *
 * Old paths must keep serving the same handlers (shared functions, so the
 * alias cannot drift) and log a deprecation pointer ONCE per (method, mount).
 * These tests mirror run.ts's mounts; if run.ts changes its alias wiring,
 * change it here in lockstep — this file is deleted with the aliases next
 * release.
 */
process.env.AUTONOMOS_CONFIG_DIR ??= join(
  tmpdir(),
  `autonomos-alias-${randomUUID()}`,
);

const { deprecatedAlias, _resetDeprecationWarnings } = await import(
  "../deprecation.js"
);
const { agentStatusRouter, hooksReadRouter, notificationsRouter } =
  await import("../routes/hooks.js");
const { scheduleRouter, schedulerRouter } = await import(
  "../routes/schedules.js"
);

function buildApp(): Hono {
  // Mirrors run.ts (new mounts + aliases).
  const app = new Hono();
  app.route("/api/agent-status", agentStatusRouter);
  app.route("/api/notifications", notificationsRouter);
  app.use(
    "/api/hooks/*",
    deprecatedAlias("/api/hooks", "/api/agent-status + /api/notifications"),
  );
  app.route("/api/hooks", hooksReadRouter);
  app.route("/api/schedules", schedulerRouter);
  app.route("/api/schedules", scheduleRouter);
  app.use(
    "/api/scheduler/*",
    deprecatedAlias("/api/scheduler", "/api/schedules/{status,settings}"),
  );
  app.route("/api/scheduler", schedulerRouter);
  return app;
}

let warns: string[] = [];
const origWarn = console.warn;

beforeEach(() => {
  _resetDeprecationWarnings();
  warns = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  // Restore after each test body via the test runner's natural flow — the
  // next beforeEach reassigns; final restore below in the last test.
});

describe("route-rename compat aliases (PR C)", () => {
  it("new paths serve: /api/agent-status, /api/notifications, /api/schedules/status", async () => {
    const app = buildApp();
    assert.equal((await app.request("/api/agent-status")).status, 200);
    assert.equal((await app.request("/api/notifications")).status, 200);
    assert.equal((await app.request("/api/schedules/status")).status, 200);
  });

  it("old read paths still serve identical payloads through the alias", async () => {
    const app = buildApp();
    const oldStatus = await (await app.request("/api/hooks")).json();
    const newStatus = await (await app.request("/api/agent-status")).json();
    assert.deepEqual(oldStatus, newStatus);

    const oldFeed = await (
      await app.request("/api/hooks/notifications")
    ).json();
    const newFeed = await (await app.request("/api/notifications")).json();
    assert.deepEqual(oldFeed, newFeed);

    const oldScheduler = await app.request("/api/scheduler/status");
    assert.equal(oldScheduler.status, 200);
  });

  it("scheduler control stays ahead of the :name router (mount order is load-bearing)", async () => {
    const app = buildApp();
    const res = await app.request("/api/schedules/status");
    const body = (await res.json()) as Record<string, unknown>;
    // Scheduler status shape, not a schedule record / 404 — this breaks if
    // someone reorders the /api/schedules mounts in run.ts (mirrored here).
    assert.ok("running" in body || "maxConcurrentRuns" in body);
  });

  it("creating a schedule named 'status' or 'settings' is rejected (reserved)", async () => {
    const { validateScheduleInput } = await import("../schedules.js");
    for (const name of ["status", "settings"]) {
      const err = validateScheduleInput({ name });
      assert.ok(err?.includes("reserved"), `${name}: ${err}`);
    }
    assert.equal(validateScheduleInput({ name: "normal-name" }), null);
  });

  it("the BARE old path (/api/hooks, no sub-path) matches the wildcard alias and warns", async () => {
    // The single most likely straggler is a stale dashboard's statusApi.map()
    // calling exactly GET /api/hooks with no sub-path. This pins two facts the
    // combined-count test cannot distinguish: the bare path SERVES through the
    // alias, and it PRODUCES a deprecation line (i.e. `use("/api/hooks/*")`
    // matches the bare mount path too).
    const app = buildApp();
    const res = await app.request("/api/hooks");
    assert.equal(res.status, 200);
    const deprecations = warns.filter((w) => w.includes("[deprecated]"));
    assert.equal(deprecations.length, 1, deprecations.join("\n"));
    assert.ok(deprecations[0].includes("GET /api/hooks"));
  });

  it("each alias warns ONCE per mount, pointing at the new path", async () => {
    const app = buildApp();
    await app.request("/api/hooks");
    await app.request("/api/hooks");
    await app.request("/api/hooks/notifications");
    await app.request("/api/scheduler/status");
    await app.request("/api/scheduler/status");

    const deprecations = warns.filter((w) => w.includes("[deprecated]"));
    // One per (method, old mount): /api/hooks + /api/scheduler.
    assert.equal(deprecations.length, 2, deprecations.join("\n"));
    assert.ok(deprecations.some((w) => w.includes("/api/agent-status")));
    assert.ok(
      deprecations.some((w) => w.includes("/api/schedules/{status,settings}")),
    );
    console.warn = origWarn;
  });
});
