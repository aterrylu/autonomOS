import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
  ensureConfigDir,
} from "../configDir.js";
import {
  _resetCacheForTesting,
  getPersistedSessions,
  markSessionExited,
  persistSession,
} from "../persisted.js";

/**
 * Tests for the exitedAt + exitReason schema additions that back the
 * sidebar's 24h-default exited filter and relative timestamps.
 *
 * Isolated temp directory — never touches prod ~/.autonomos/sessions.json.
 */

let tmpDir: string;

function writeRawSessions(data: unknown[]): void {
  ensureConfigDir();
  const file = join(tmpDir, "sessions.json");
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  _resetCacheForTesting();
}

function readRawSessions(): unknown[] {
  const file = join(tmpDir, "sessions.json");
  return JSON.parse(readFileSync(file, "utf-8"));
}

describe("persisted exit metadata — exitedAt + exitReason", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-test-exit-meta-"));
    _setConfigDirForTesting(tmpDir);
  });

  beforeEach(() => {
    writeRawSessions([]);
  });

  after(() => {
    _resetCacheForTesting();
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("markSessionExited sets exitedAt + exitReason on a running session", () => {
    persistSession({
      claudeSessionId: "s1",
      workingDirectory: "/tmp",
      name: "agent-1",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "running",
    });

    const before = Date.now();
    markSessionExited("s1", "user_killed");

    const [saved] = getPersistedSessions();
    assert.equal(saved.status, "exited");
    assert.equal(saved.exitReason, "user_killed");
    assert.ok(saved.exitedAt !== undefined, "exitedAt should be set");
    assert.ok(
      (saved.exitedAt ?? 0) >= before,
      "exitedAt should be recent (>= call time)",
    );
  });

  it("markSessionExited does not overwrite an existing reason", () => {
    persistSession({
      claudeSessionId: "s2",
      workingDirectory: "/tmp",
      name: "agent-2",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "running",
    });
    markSessionExited("s2", "self_exited");
    const firstExitedAt = getPersistedSessions()[0].exitedAt;

    // Second call — e.g. permanentlyRemoveSession calling killSession
    // internally after a natural exit already fired. We want the original
    // context preserved.
    markSessionExited("s2", "user_killed");

    const [saved] = getPersistedSessions();
    assert.equal(saved.exitReason, "self_exited", "first reason should win");
    assert.equal(
      saved.exitedAt,
      firstExitedAt,
      "first exitedAt should be preserved",
    );
  });

  it("markSessionExited backfills a reason when the record was already exited without one", () => {
    // Simulate a pre-schema exited record
    writeRawSessions([
      {
        claudeSessionId: "legacy",
        workingDirectory: "/tmp",
        name: "legacy-agent",
        autonomousMode: true,
        persistedAt: 1000,
        status: "exited",
      },
    ]);

    markSessionExited("legacy", "crashed");

    const [saved] = getPersistedSessions();
    assert.equal(saved.exitReason, "crashed");
    assert.ok(saved.exitedAt !== undefined, "exitedAt should be backfilled");
  });

  it("re-persisting with status running clears exit metadata (resume path)", () => {
    persistSession({
      claudeSessionId: "s3",
      workingDirectory: "/tmp",
      name: "agent-3",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "running",
    });
    markSessionExited("s3", "user_killed");
    assert.ok(getPersistedSessions()[0].exitedAt !== undefined);

    // Now the user resumes the agent — createSession persists with status "running"
    persistSession({
      claudeSessionId: "s3",
      workingDirectory: "/tmp",
      name: "agent-3",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "running",
    });

    const [saved] = getPersistedSessions();
    assert.equal(saved.status, "running");
    assert.equal(
      saved.exitedAt,
      undefined,
      "exitedAt should be cleared on resume",
    );
    assert.equal(
      saved.exitReason,
      undefined,
      "exitReason should be cleared on resume",
    );
  });

  it("pre-schema records (no exitedAt/exitReason) load without crashing", () => {
    writeRawSessions([
      {
        claudeSessionId: "old-1",
        workingDirectory: "/tmp",
        name: "old-agent",
        autonomousMode: true,
        persistedAt: 1000,
        status: "exited",
      },
    ]);

    const loaded = getPersistedSessions();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].exitedAt, undefined);
    assert.equal(loaded[0].exitReason, undefined);
    assert.equal(loaded[0].status, "exited");
  });

  it("exitedAt and exitReason round-trip through disk", () => {
    persistSession({
      claudeSessionId: "s4",
      workingDirectory: "/tmp",
      name: "agent-4",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "running",
    });
    markSessionExited("s4", "crashed");

    // Read the raw file to ensure the fields hit disk, not just memory
    const raw = readRawSessions() as Array<Record<string, unknown>>;
    const entry = raw.find((s) => s.claudeSessionId === "s4");
    assert.ok(entry, "entry should be written to disk");
    assert.equal(entry!.status, "exited");
    assert.equal(entry!.exitReason, "crashed");
    assert.ok(typeof entry!.exitedAt === "number");
  });
});
