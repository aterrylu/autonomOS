import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CONFIG_DIR, ensureConfigDir } from "../configDir.js";
import { buildOrgChart, type OrgNode } from "../orgChart.js";
import { getPersistedSessions, persistSession } from "../persisted.js";

/**
 * Tests for backward compatibility — old persisted sessions missing
 * fields added in recent PRs should still load and render correctly.
 *
 * These tests snapshot and restore sessions.json to avoid polluting
 * real persisted data with raw JSON test entries.
 */

const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

let savedContent: string | null = null;

function writeRawSessions(data: unknown[]): void {
  ensureConfigDir();
  writeFileSync(SESSIONS_FILE, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
}

function findByName(roots: OrgNode[], name: string): OrgNode | undefined {
  for (const n of roots) {
    if (n.name === name) return n;
    const found = findByName(n.children, name);
    if (found) return found;
  }
  return undefined;
}

describe("backward compatibility — old session formats", () => {
  before(() => {
    ensureConfigDir();
    savedContent = existsSync(SESSIONS_FILE)
      ? readFileSync(SESSIONS_FILE, "utf-8")
      : null;
  });

  after(() => {
    if (savedContent !== null) {
      writeFileSync(SESSIONS_FILE, savedContent, { mode: 0o600 });
    }
  });

  it("loads sessions missing autonomousMode (pre-template era)", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-no-automode",
        workingDirectory: "/tmp",
        name: "BackCompat_NoAutoMode",
        persistedAt: 1000,
      },
    ]);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === "bc-test-no-automode",
    );
    assert.ok(found, "session without autonomousMode should load");
    assert.equal(found.autonomousMode, true, "should default to true");
  });

  it("loads sessions missing persistedAt", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-no-persisted-at",
        workingDirectory: "/tmp",
        name: "BackCompat_NoPAt",
        autonomousMode: false,
      },
    ]);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === "bc-test-no-persisted-at",
    );
    assert.ok(found, "session without persistedAt should load");
    assert.equal(found.persistedAt, 0, "should default to 0");
    assert.equal(
      found.autonomousMode,
      false,
      "explicit false should be preserved",
    );
  });

  it("loads sessions missing status (pre-persist-exited era)", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-no-status",
        workingDirectory: "/tmp",
        name: "BackCompat_NoStatus",
        autonomousMode: true,
        persistedAt: 1000,
      },
    ]);

    const loaded = getPersistedSessions();
    const found = loaded.find((s) => s.claudeSessionId === "bc-test-no-status");
    assert.ok(found, "session without status should load");
    assert.equal(found.status, undefined, "status should remain undefined");
  });

  it("loads minimal session (only 3 required fields)", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-minimal",
        workingDirectory: "/tmp",
        name: "BackCompat_Minimal",
      },
    ]);

    const loaded = getPersistedSessions();
    const found = loaded.find((s) => s.claudeSessionId === "bc-test-minimal");
    assert.ok(found, "minimal session should load");
    assert.equal(found.autonomousMode, true);
    assert.equal(found.persistedAt, 0);
  });

  it("rejects sessions missing name", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-no-name",
        workingDirectory: "/tmp",
        autonomousMode: true,
        persistedAt: 1000,
      },
    ]);

    const loaded = getPersistedSessions();
    const found = loaded.find((s) => s.claudeSessionId === "bc-test-no-name");
    assert.equal(found, undefined, "session without name should be rejected");
  });

  it("rejects sessions missing claudeSessionId", () => {
    writeRawSessions([
      {
        workingDirectory: "/tmp",
        name: "BackCompat_NoId",
        autonomousMode: true,
      },
    ]);

    const loaded = getPersistedSessions();
    assert.equal(loaded.length, 0, "session without claudeSessionId rejected");
  });

  it("old sessions appear in org chart as running", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-orgchart-old",
        workingDirectory: "/tmp",
        name: "BackCompat_OrgChart",
      },
    ]);

    const chart = buildOrgChart();
    const node = findByName(chart, "BackCompat_OrgChart");
    assert.ok(node, "old session should appear in org chart");
    assert.equal(
      node.status,
      "running",
      "missing status should default to running",
    );
  });

  it("old sessions with manager field appear in hierarchy", () => {
    writeRawSessions([
      {
        claudeSessionId: "bc-test-parent",
        workingDirectory: "/tmp",
        name: "BackCompat_Manager",
        persistedAt: 1000,
      },
      {
        claudeSessionId: "bc-test-child",
        workingDirectory: "/tmp",
        name: "BackCompat_Worker",
        manager: "BackCompat_Manager",
        persistedAt: 1000,
      },
    ]);

    const chart = buildOrgChart();
    const manager = findByName(chart, "BackCompat_Manager");
    assert.ok(manager);
    assert.equal(manager.children.length, 1);
    assert.equal(manager.children[0].name, "BackCompat_Worker");
  });
});
