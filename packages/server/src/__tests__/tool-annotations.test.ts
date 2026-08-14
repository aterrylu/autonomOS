import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOLS } from "../mcp/tools.js";

/**
 * `readOnlyHint` is load-bearing, not decorative. The channel server serves
 * `ALL_TOOLS` verbatim, so these annotations reach every spawned agent, and:
 *   - Codex auto-approves a read-only tool under `default_tools_approval_mode`
 *     "writes" (the ask/plan mapping) — so a supervised agent is prompted for
 *     mutations but NOT for reads. Drop the hint from a read-only tool and the
 *     every-session approval prompt comes back for it.
 *   - Claude Code uses it for parallel-execution eligibility.
 * The inverse is a safety property: a MUTATING tool must never claim
 * `readOnlyHint`, or Codex would auto-approve a side-effecting call (kill_agent,
 * delete_*) even for an `ask`-mode agent.
 *
 * This test is the drift guard for both directions.
 */

/** The tools with no side effects — everything else mutates or acts. */
const READ_ONLY = new Set([
  "list_agents",
  "get_org_chart",
  "list_templates",
  "list_schedules",
  "get_schedule",
  "list_env_presets",
]);

describe("tool annotations (readOnlyHint)", () => {
  it("every read-only tool declares readOnlyHint: true", () => {
    for (const name of READ_ONLY) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      assert.ok(tool, `read-only tool "${name}" should exist in ALL_TOOLS`);
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `"${name}" is read-only — it must declare annotations.readOnlyHint: true`,
      );
    }
  });

  it("no mutating tool declares readOnlyHint (would auto-approve a side-effecting call)", () => {
    for (const tool of ALL_TOOLS) {
      if (READ_ONLY.has(tool.name)) continue;
      assert.notEqual(
        tool.annotations?.readOnlyHint,
        true,
        `"${tool.name}" has side effects — it must NOT declare readOnlyHint: true`,
      );
    }
  });

  it("the READ_ONLY set names only tools that actually exist (no stale entries)", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const name of READ_ONLY) {
      assert.ok(names.has(name), `READ_ONLY names "${name}" but no such tool`);
    }
  });
});
