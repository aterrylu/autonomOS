import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { CONFIG_DIR } from "../configDir.js";
import { buildOrgChart, type OrgNode } from "../orgChart.js";
import {
  getPersistedSessions,
  persistSession,
  removePersistedSession,
} from "../persisted.js";

/**
 * Tests for backward compatibility — old persisted sessions missing
 * fields added in recent PRs should still load and render correctly.
 */

const TEST_PREFIX = "backcompat-test-";
const testIds: string[] = [];
const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

function readRawSessions(): unknown[] {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeRawSessions(data: unknown[]): void {
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + "\n", {
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
  let originalSessions: unknown[];

  before(() => {
    originalSessions = readRawSessions();
    // Clean any stale test entries
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

  it("loads sessions missing autonomousMode (pre-template era)", () => {
    const sessions = readRawSessions();
    const oldSession = {
      claudeSessionId: `${TEST_PREFIX}no-automode`,
      workingDirectory: "/tmp",
      name: "BackCompat_NoAutoMode",
      persistedAt: Date.now(),
    };
    testIds.push(oldSession.claudeSessionId);
    sessions.push(oldSession);
    writeRawSessions(sessions);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === oldSession.claudeSessionId,
    );
    assert.ok(found, "session without autonomousMode should load");
    assert.equal(found.autonomousMode, true, "should default to true");
  });

  it("loads sessions missing persistedAt", () => {
    const sessions = readRawSessions();
    const oldSession = {
      claudeSessionId: `${TEST_PREFIX}no-persisted-at`,
      workingDirectory: "/tmp",
      name: "BackCompat_NoPAt",
      autonomousMode: false,
    };
    testIds.push(oldSession.claudeSessionId);
    sessions.push(oldSession);
    writeRawSessions(sessions);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === oldSession.claudeSessionId,
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
    const sessions = readRawSessions();
    const oldSession = {
      claudeSessionId: `${TEST_PREFIX}no-status`,
      workingDirectory: "/tmp",
      name: "BackCompat_NoStatus",
      autonomousMode: true,
      persistedAt: Date.now(),
    };
    testIds.push(oldSession.claudeSessionId);
    sessions.push(oldSession);
    writeRawSessions(sessions);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === oldSession.claudeSessionId,
    );
    assert.ok(found, "session without status should load");
    assert.equal(found.status, undefined, "status should remain undefined");
  });

  it("loads minimal session (only 3 required fields)", () => {
    const sessions = readRawSessions();
    const minimalSession = {
      claudeSessionId: `${TEST_PREFIX}minimal`,
      workingDirectory: "/tmp",
      name: "BackCompat_Minimal",
    };
    testIds.push(minimalSession.claudeSessionId);
    sessions.push(minimalSession);
    writeRawSessions(sessions);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === minimalSession.claudeSessionId,
    );
    assert.ok(found, "minimal session should load");
    assert.equal(found.autonomousMode, true);
    assert.equal(found.persistedAt, 0);
  });

  it("rejects sessions missing name", () => {
    const sessions = readRawSessions();
    const badSession = {
      claudeSessionId: `${TEST_PREFIX}no-name`,
      workingDirectory: "/tmp",
      autonomousMode: true,
      persistedAt: Date.now(),
    };
    testIds.push(badSession.claudeSessionId);
    sessions.push(badSession);
    writeRawSessions(sessions);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.claudeSessionId === badSession.claudeSessionId,
    );
    assert.equal(found, undefined, "session without name should be rejected");
  });

  it("rejects sessions missing claudeSessionId", () => {
    const sessions = readRawSessions();
    const badSession = {
      workingDirectory: "/tmp",
      name: "BackCompat_NoId",
      autonomousMode: true,
    };
    sessions.push(badSession);
    writeRawSessions(sessions);

    const loaded = getPersistedSessions();
    const found = loaded.find(
      (s) => s.name === "BackCompat_NoId" && !s.claudeSessionId,
    );
    assert.equal(
      found,
      undefined,
      "session without claudeSessionId should be rejected",
    );
  });

  it("old sessions appear in org chart as running", () => {
    const sessions = readRawSessions();
    const oldSession = {
      claudeSessionId: `${TEST_PREFIX}orgchart-old`,
      workingDirectory: "/tmp",
      name: "BackCompat_OrgChart",
    };
    testIds.push(oldSession.claudeSessionId);
    sessions.push(oldSession);
    writeRawSessions(sessions);

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
    const id1 = `${TEST_PREFIX}parent-old`;
    const id2 = `${TEST_PREFIX}child-old`;
    testIds.push(id1, id2);

    persistSession({
      claudeSessionId: id1,
      workingDirectory: "/tmp",
      name: "BackCompat_Manager",
      autonomousMode: true,
      persistedAt: Date.now(),
    });
    persistSession({
      claudeSessionId: id2,
      workingDirectory: "/tmp",
      name: "BackCompat_Worker",
      autonomousMode: true,
      persistedAt: Date.now(),
      manager: "BackCompat_Manager",
    });

    const chart = buildOrgChart();
    const manager = findByName(chart, "BackCompat_Manager");
    assert.ok(manager);
    assert.equal(manager.children.length, 1);
    assert.equal(manager.children[0].name, "BackCompat_Worker");
  });
});
