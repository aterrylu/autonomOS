import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOLS, MCP_INSTRUCTIONS } from "../mcp/tools.js";

/**
 * Keeps MCP_INSTRUCTIONS (the prose injected into every agent's system prompt +
 * advertised as the channel MCP server's `instructions`) in sync with the
 * ACTUAL tool set (ALL_TOOLS). The "kept deliberately in sync" comment on
 * ALL_TOOLS was enforced by nothing, so it drifted — env-preset tools were only
 * added by hand, and a "platforms" line outlived the ADR-064 scheme removal.
 * This test is that enforcement, in both directions.
 */
describe("MCP_INSTRUCTIONS ↔ ALL_TOOLS correspondence", () => {
  const toolNames = new Set(ALL_TOOLS.map((t) => t.name));

  it("names EVERY registered tool (added a tool → must document it)", () => {
    for (const name of toolNames) {
      assert.ok(
        MCP_INSTRUCTIONS.includes(`${name}(`),
        `tool "${name}" is in ALL_TOOLS but not mentioned as "${name}(" in MCP_INSTRUCTIONS`,
      );
    }
  });

  it("mentions NO tool that isn't registered (removed a tool → must undocument it)", () => {
    // Every `snake_case(` call token in the prose must be a real tool. Catches a
    // removed tool the prose still advertises (the broadcast/platform class).
    const mentioned = new Set(
      [...MCP_INSTRUCTIONS.matchAll(/\b([a-z][a-z_]+)\(/g)].map((m) => m[1]),
    );
    for (const name of mentioned) {
      assert.ok(
        toolNames.has(name),
        `MCP_INSTRUCTIONS advertises "${name}()" but no such tool is in ALL_TOOLS`,
      );
    }
  });

  it("advertises no removed schemes (broadcast:// / slack:// / platform)", () => {
    // ADR-064 removed broadcast:// and the platform adapters. "There is no
    // broadcast" is allowed (it teaches the removal); the SCHEME must not appear.
    assert.ok(
      !/broadcast:\/\//.test(MCP_INSTRUCTIONS),
      "broadcast:// scheme leaked back in",
    );
    assert.ok(
      !/slack:\/\//.test(MCP_INSTRUCTIONS),
      "slack:// scheme leaked back in",
    );
    assert.ok(
      !/from other agents and platforms/.test(MCP_INSTRUCTIONS),
      "stale 'and platforms' phrasing (platform schemes were removed in ADR-064)",
    );
  });

  it("keeps the peer-discovery guidance (the recurring Codex confusion)", () => {
    // A Codex agent read its native per-thread list, saw it empty, and concluded
    // it was alone. The prose must steer peers to list_agents().
    assert.match(MCP_INSTRUCTIONS, /list_agents\(\)/);
    assert.match(MCP_INSTRUCTIONS, /native|built-in/i);
  });
});
