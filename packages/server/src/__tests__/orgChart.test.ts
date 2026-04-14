import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { buildOrgChart, type OrgNode } from "../orgChart.js";
import {
  _resetCacheForTesting,
  persistSession,
  removePersistedSession,
} from "../persisted.js";

/**
 * Tests for buildOrgChart() — particularly the name-collision path.
 *
 * All tests use an isolated temp directory so they never touch
 * the production ~/.autonomos/sessions.json.
 */

let tmpDir: string;
const testIds: string[] = [];

function makeTestSession(
  suffix: string,
  overrides: {
    name: string;
    status?: "running" | "exited";
    manager?: string;
    persistedAt?: number;
  },
) {
  const id = `orgchart-test-${suffix}`;
  testIds.push(id);
  persistSession({
    claudeSessionId: id,
    workingDirectory: "/tmp",
    name: overrides.name,
    autonomousMode: true,
    persistedAt: overrides.persistedAt ?? Date.now(),
    status: overrides.status,
    manager: overrides.manager,
  });
  return id;
}

function findByName(roots: OrgNode[], name: string): OrgNode | undefined {
  for (const n of roots) {
    if (n.name === name) return n;
    const found = findByName(n.children, name);
    if (found) return found;
  }
  return undefined;
}

describe("buildOrgChart() — name collision handling", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-test-orgchart-"));
    _setConfigDirForTesting(tmpDir);
    _resetCacheForTesting();
  });

  afterEach(() => {
    for (const id of testIds) removePersistedSession(id);
    testIds.length = 0;
  });

  after(() => {
    _resetCacheForTesting();
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers the running session when two sessions share a name", () => {
    makeTestSession("exited-1", {
      name: "CollisionTest_Alpha",
      status: "exited",
      persistedAt: 1000,
    });
    const runningId = makeTestSession("running-1", {
      name: "CollisionTest_Alpha",
      status: "running",
      persistedAt: 500,
    });

    const chart = buildOrgChart();
    const node = findByName(chart, "CollisionTest_Alpha");
    assert.ok(node, "expected CollisionTest_Alpha in chart");
    assert.equal(
      node.status,
      "running",
      "running status should win over exited",
    );
    assert.equal(
      node.claudeSessionId,
      runningId,
      "node should carry the running session's ID",
    );
  });

  it("breaks running-only ties by newest persistedAt", () => {
    makeTestSession("running-older", {
      name: "CollisionTest_Beta",
      status: "running",
      persistedAt: 1000,
    });
    const newerId = makeTestSession("running-newer", {
      name: "CollisionTest_Beta",
      status: "running",
      persistedAt: 2000,
    });

    const chart = buildOrgChart();
    const node = findByName(chart, "CollisionTest_Beta");
    assert.ok(node);
    assert.equal(node.claudeSessionId, newerId);
  });

  it("falls back to newest exited when all sessions with a name are exited", () => {
    makeTestSession("exited-older", {
      name: "CollisionTest_Gamma",
      status: "exited",
      persistedAt: 1000,
    });
    const newerExitedId = makeTestSession("exited-newer", {
      name: "CollisionTest_Gamma",
      status: "exited",
      persistedAt: 2000,
    });

    const chart = buildOrgChart(true);
    const node = findByName(chart, "CollisionTest_Gamma");
    assert.ok(node);
    assert.equal(node.status, "exited");
    assert.equal(node.claudeSessionId, newerExitedId);
  });

  it("filters out exited agents by default", () => {
    makeTestSession("running-filter", {
      name: "CollisionTest_FilterRunning",
      status: "running",
    });
    makeTestSession("exited-filter", {
      name: "CollisionTest_FilterExited",
      status: "exited",
    });

    const chart = buildOrgChart();
    assert.ok(findByName(chart, "CollisionTest_FilterRunning"));
    assert.equal(
      findByName(chart, "CollisionTest_FilterExited"),
      undefined,
      "exited agent should be hidden by default",
    );

    const fullChart = buildOrgChart(true);
    assert.ok(findByName(fullChart, "CollisionTest_FilterExited"));
  });

  it("promotes running children of exited parents to root", () => {
    makeTestSession("exited-parent", {
      name: "CollisionTest_ExitedManager",
      status: "exited",
    });
    makeTestSession("running-child", {
      name: "CollisionTest_ChildWorker",
      status: "running",
      manager: "CollisionTest_ExitedManager",
    });

    const chart = buildOrgChart();
    assert.equal(
      findByName(chart, "CollisionTest_ExitedManager"),
      undefined,
      "exited parent should be filtered",
    );
    const child = findByName(chart, "CollisionTest_ChildWorker");
    assert.ok(child, "running child should be promoted to root");
  });

  it("does not push the same node twice under its parent", () => {
    makeTestSession("parent-for-dup", {
      name: "CollisionTest_Manager",
      status: "running",
    });
    makeTestSession("child-running", {
      name: "CollisionTest_Worker",
      status: "running",
      manager: "CollisionTest_Manager",
    });
    makeTestSession("child-exited", {
      name: "CollisionTest_Worker",
      status: "exited",
      manager: "CollisionTest_Manager",
    });

    const chart = buildOrgChart();
    const manager = findByName(chart, "CollisionTest_Manager");
    assert.ok(manager);
    const workers = manager.children.filter(
      (c) => c.name === "CollisionTest_Worker",
    );
    assert.equal(
      workers.length,
      1,
      "exactly one Worker node should appear under its manager",
    );
    assert.equal(workers[0].status, "running", "the running one should win");
  });

  it("includes status and claudeSessionId on every node", () => {
    const id = makeTestSession("single", {
      name: "CollisionTest_Delta",
      status: "running",
    });
    const chart = buildOrgChart();
    const node = findByName(chart, "CollisionTest_Delta");
    assert.ok(node);
    assert.equal(node.claudeSessionId, id);
    assert.equal(node.status, "running");
  });
});
