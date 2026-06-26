import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { _resetCacheForTesting, getAgent, saveAgent } from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

/**
 * Upgrade backward-compat (ADR-045): a server running the OLD code persisted
 * per-agent records with `autonomousMode: boolean` and no `permissionMode`.
 * After upgrading, the NEW store must load those files without error and derive
 * the correct mode (accept-and-discard), never crash on the missing required
 * field, and scrub the legacy field on the next write.
 */
describe("agent record upgrade compat: legacy autonomousMode → permissionMode", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-store-migrate-"));
  });
  after(() => rmSync(tmpDir, { recursive: true, force: true }));
  beforeEach(() => _setConfigDirForTesting(tmpDir));
  afterEach(() => {
    _resetCacheForTesting();
    _resetConfigDirForTesting();
  });

  /** Write a record shaped exactly as the OLD server wrote it. */
  function writeLegacyAgent(id: string, extra: Record<string, unknown>): void {
    const dir = join(tmpDir, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: "Legacy",
        managerId: null,
        workingDirectory: "/tmp",
        status: "running",
        provider: "claude-code",
        providerSessionId: id,
        startedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
        ...extra,
      }),
    );
  }

  function load(id: string) {
    _resetCacheForTesting(); // force a fresh read from disk
    return getAgent(id);
  }

  it("autonomousMode:true → permissionMode 'bypass' (preserves prior autonomy)", () => {
    writeLegacyAgent("agent-true", { autonomousMode: true });
    const a = load("agent-true");
    assert.equal(a?.permissionMode, "bypass");
  });

  it("autonomousMode:false → permissionMode 'default' (preserves supervised)", () => {
    writeLegacyAgent("agent-false", { autonomousMode: false });
    const a = load("agent-false");
    assert.equal(a?.permissionMode, "default");
    assert.ok(
      !("autonomousMode" in (a as object)),
      "legacy field scrubbed in memory",
    );
  });

  it("missing both fields → DEFAULT (bypass), never undefined", () => {
    writeLegacyAgent("agent-none", {});
    const a = load("agent-none");
    assert.equal(a?.permissionMode, "bypass");
  });

  it("malformed permissionMode string is coerced, not trusted", () => {
    writeLegacyAgent("agent-bad", { permissionMode: "yolo" });
    const a = load("agent-bad");
    assert.equal(a?.permissionMode, "bypass");
  });

  it("scrubs the legacy field on the next write (accept-and-discard)", () => {
    writeLegacyAgent("agent-persist", { autonomousMode: true });
    const a = load("agent-persist");
    assert.ok(a);
    saveAgent(a);
    // Read the raw file to prove the legacy field was scrubbed ON DISK, not
    // merely hidden in memory by the load-time backfill.
    const raw = JSON.parse(
      readFileSync(join(tmpDir, "agents", "agent-persist.json"), "utf-8"),
    );
    assert.equal(raw.permissionMode, "bypass");
    assert.ok(!("autonomousMode" in raw), "old field not re-persisted to disk");
  });
});
