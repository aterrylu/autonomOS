import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { buildOrgChart, type OrgNode } from "../orgChart.js";
import {
  getPersistedSessions,
  persistSession,
  removePersistedSession,
} from "../persisted.js";

/**
 * Tests for buildOrgChart() — particularly the name-collision path.
 *
 * These tests write to the real ~/.autonomos/sessions.json since there is
 * no mocking layer for persistence. They use unique claudeSessionIds
 * (prefixed with "orgchart-test-") and clean up in afterEach to avoid
 * polluting the real sessions file.
 */

// Unique prefix so we can identify and clean up our test entries even if
// the test crashes mid-run.
const TEST_PREFIX = "orgchart-test-";
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
  const id = `${TEST_PREFIX}${suffix}`;
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

/** Find a node by name in the chart (recursive). */
function findByName(roots: OrgNode[], name: string): OrgNode | undefined {
  for (const n of roots) {
    if (n.name === name) return n;
    const found = findByName(n.children, name);
    if (found) return found;
  }
  return undefined;
}

describe("buildOrgChart() — name collision handling", () => {
  // Startup sweep: remove any stale test entries from a prior crashed run.
  // Without this, a Ctrl-C between persistSession and afterEach would leak
  // orgchart-test-* entries into the user's real sessions.json forever.
  before(() => {
    for (const s of getPersistedSessions()) {
      if (s.claudeSessionId.startsWith(TEST_PREFIX)) {
        removePersistedSession(s.claudeSessionId);
      }
    }
  });

  afterEach(() => {
    for (const id of testIds) removePersistedSession(id);
    testIds.length = 0;
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
      persistedAt: 500, // older — but running should still win
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
    const olderId = makeTestSession("running-older", {
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
    assert.notEqual(node.claudeSessionId, olderId);
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

    const chart = buildOrgChart();
    const node = findByName(chart, "CollisionTest_Gamma");
    assert.ok(node);
    assert.equal(node.status, "exited");
    assert.equal(node.claudeSessionId, newerExitedId);
  });

  it("does not push the same node twice under its parent", () => {
    // Regression: old implementation pushed the same node object into the
    // parent's children array once for each duplicate name.
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
