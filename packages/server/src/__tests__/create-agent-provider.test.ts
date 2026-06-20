import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_CREATE_AGENT } from "../mcp/tools.js";

/**
 * The MCP `create_agent` tool must expose a `provider` field so agents (e.g.
 * Dispatcher) can spawn Codex/Gemini runtimes — not just Claude Code. Without
 * it there was no way to request a non-default runtime through the tool.
 */
describe("create_agent tool exposes provider", () => {
  it("declares a provider enum covering all runtimes", () => {
    const props = TOOL_CREATE_AGENT.inputSchema.properties as Record<
      string,
      { type?: string; enum?: string[] }
    >;
    assert.ok(props.provider, "create_agent must have a `provider` property");
    assert.deepEqual([...(props.provider.enum ?? [])].sort(), [
      "claude-code",
      "codex",
      "gemini-cli",
    ]);
  });

  it("keeps provider optional (defaults to claude-code)", () => {
    const required = TOOL_CREATE_AGENT.inputSchema.required ?? [];
    assert.ok(!required.includes("provider"));
  });
});
