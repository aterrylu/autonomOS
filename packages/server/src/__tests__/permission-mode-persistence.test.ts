/**
 * The spawn/record divergence — the bug this suite exists to prevent.
 *
 * A resume carries the CALLER's permission mode into the provider argv
 * (`resolved` is built from the spawn params), but the reattach persist used
 * `markRunning`, whose patch type could not express a `permissionMode` at all.
 * So `create_agent(resumeSessionId: B, permissionMode: "bypass")` on a record
 * holding "ask" launched a PTY with `--dangerously-skip-permissions` while the
 * record — and therefore the API, the dashboard, and every audit surface —
 * kept saying "ask", for the life of that process.
 *
 * It was invisible from any single layer: the argv was right, the record was
 * internally consistent, and the next record-driven respawn quietly put the
 * agent BACK to "ask", so the mismatch even healed itself in the safe
 * direction. Only comparing the two layers reveals it. That is what these
 * tests do.
 *
 * They pin the persistence seam directly (deterministic, no PTY). The
 * end-to-end argv-vs-record check lives in the RUN_INTEGRATION spawn suite.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PermissionMode, UUID } from "@autonomos/core";
import {
  _resetCacheForTesting,
  buildAgent,
  getAgent,
  insertAgent,
  markExited,
  markRunning,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

describe("permission mode survives the reattach persist", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-permmode-persist-"));
  });
  after(() => rmSync(tmpDir, { recursive: true, force: true }));
  beforeEach(() => {
    _setConfigDirForTesting(tmpDir);
    mkdirSync(join(tmpDir, "agents"), { recursive: true });
  });
  afterEach(() => {
    _resetCacheForTesting();
    _resetConfigDirForTesting();
  });

  /** Insert a running agent holding `mode`, as a fresh spawn would. */
  function seed(id: string, mode: PermissionMode) {
    const agent = buildAgent({
      id: id as UUID,
      name: `agent-${id}`,
      workingDirectory: "/tmp",
      provider: "claude-code",
      providerSessionId: id,
      permissionMode: mode,
      managerId: null,
    });
    insertAgent(agent);
    return agent;
  }

  /** Read the mode straight off disk — not from the in-memory cache, which
   *  could agree with the caller while the file disagrees. */
  function modeOnDisk(id: string): unknown {
    const raw = JSON.parse(
      readFileSync(join(tmpDir, "agents", `${id}.json`), "utf-8"),
    );
    return raw.permissionMode;
  }

  it("an explicit mode on reattach is written to the record", () => {
    // THE regression test. Before the fix, markRunning's patch type had no
    // permissionMode, so this write was impossible to express and the record
    // stayed on the old mode while the PTY ran the new one.
    seed("agent-escalate", "ask");
    markExited("agent-escalate" as UUID, "user_killed");

    markRunning("agent-escalate" as UUID, {
      provider: "claude-code",
      providerSessionId: "agent-escalate",
      startedAt: Date.now(),
      permissionMode: "bypass",
    });

    assert.equal(
      getAgent("agent-escalate" as UUID)?.permissionMode,
      "bypass",
      "the record must follow the mode the process was actually launched with",
    );
    assert.equal(
      modeOnDisk("agent-escalate"),
      "bypass",
      "and it must reach disk, not just the cache — a restart re-reads the file",
    );
  });

  it("de-escalation is recorded too, not just escalation", () => {
    // The same seam in the other direction. Worth its own case: a fix that
    // only ever wrote a MORE permissive value would pass the test above.
    seed("agent-restrict", "bypass");
    markExited("agent-restrict" as UUID, "user_killed");

    markRunning("agent-restrict" as UUID, {
      provider: "claude-code",
      providerSessionId: "agent-restrict",
      startedAt: Date.now(),
      permissionMode: "plan",
    });

    assert.equal(getAgent("agent-restrict" as UUID)?.permissionMode, "plan");
    assert.equal(modeOnDisk("agent-restrict"), "plan");
  });

  it("omitting the mode PRESERVES the record's — it must never blank it", () => {
    // markRunning's other patchable fields use "undefined means clear it"
    // (providerThreadId relies on it). permissionMode is non-optional on Agent,
    // so the same convention would drop the key at JSON.stringify and silently
    // demote the agent to the fallback mode on its next load. Absent means keep.
    seed("agent-keep", "bypass");
    markExited("agent-keep" as UUID, "crashed");

    markRunning("agent-keep" as UUID, {
      provider: "claude-code",
      providerSessionId: "agent-keep",
      startedAt: Date.now(),
    });

    assert.equal(
      getAgent("agent-keep" as UUID)?.permissionMode,
      "bypass",
      "a body-less restart must not silently demote a deliberately autonomous agent",
    );
    assert.equal(
      modeOnDisk("agent-keep"),
      "bypass",
      "the key must still exist on disk — a missing one re-defaults on load",
    );
  });

  it("explicitly passing undefined also preserves, rather than clearing", () => {
    // Distinct from the case above: the key is PRESENT with value undefined,
    // which is what a caller spreading an optional field produces. A plain
    // `{...existing, ...patch}` would set it to undefined here.
    seed("agent-explicit-undef", "auto");
    markExited("agent-explicit-undef" as UUID, "user_killed");

    markRunning("agent-explicit-undef" as UUID, {
      provider: "claude-code",
      providerSessionId: "agent-explicit-undef",
      startedAt: Date.now(),
      permissionMode: undefined,
    });

    assert.equal(
      getAgent("agent-explicit-undef" as UUID)?.permissionMode,
      "auto",
    );
    assert.equal(modeOnDisk("agent-explicit-undef"), "auto");
  });

  it("restarting many agents preserves each one's OWN mode", () => {
    // The shape of restart-all: it re-reads each record and passes that
    // record's mode back in. Nothing global is consulted, so a heterogeneous
    // fleet must stay heterogeneous — no agent is levelled up to the most
    // permissive mode in the set, or down to the fallback.
    const fleet: Array<[string, PermissionMode]> = [
      ["fleet-ask", "ask"],
      ["fleet-auto", "auto"],
      ["fleet-plan", "plan"],
      ["fleet-bypass", "bypass"],
    ];
    for (const [id, mode] of fleet) {
      seed(id, mode);
      markExited(id as UUID, "user_killed");
    }

    for (const [id] of fleet) {
      const record = getAgent(id as UUID);
      assert.ok(record);
      // Exactly what respawnAgent passes: the record's own value.
      markRunning(id as UUID, {
        provider: record.provider,
        providerSessionId: record.providerSessionId,
        startedAt: Date.now(),
        permissionMode: record.permissionMode,
      });
    }

    for (const [id, mode] of fleet) {
      assert.equal(
        getAgent(id as UUID)?.permissionMode,
        mode,
        `${id} must come back as ${mode}, not another agent's mode`,
      );
    }
  });
});
