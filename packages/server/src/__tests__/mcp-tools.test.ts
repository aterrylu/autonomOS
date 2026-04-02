import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_TOOLS,
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_EXTERNAL,
  MCP_SERVER_INFO,
  SERVER_TOOLS,
  TOOL_CREATE_AGENT,
  TOOL_KILL_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_SEND,
} from "../mcp/tools.js";

describe("shared MCP tool definitions", () => {
  it("ALL_TOOLS contains all expected tools", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of [
      "create_agent",
      "list_agents",
      "kill_agent",
      "send",
      "set_manager",
      "get_org_chart",
      "list_templates",
      "create_template",
    ]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    assert.equal(ALL_TOOLS.length, 8);
  });

  it("SERVER_TOOLS excludes send (no gateway for external clients)", () => {
    const names = SERVER_TOOLS.map((t) => t.name);
    assert.ok(names.includes("create_agent"));
    assert.ok(names.includes("list_agents"));
    assert.ok(names.includes("kill_agent"));
    assert.ok(!names.includes("send"));
    assert.equal(SERVER_TOOLS.length, 7);
  });

  it("each tool has required fields", () => {
    for (const tool of ALL_TOOLS) {
      assert.ok(tool.name, `tool missing name`);
      assert.ok(tool.description, `${tool.name} missing description`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.properties !== undefined);
    }
  });

  it("create_agent requires workingDirectory", () => {
    assert.deepEqual(TOOL_CREATE_AGENT.inputSchema.required, [
      "workingDirectory",
    ]);
  });

  it("send requires to and message", () => {
    assert.deepEqual(TOOL_SEND.inputSchema.required, ["to", "message"]);
  });

  it("kill_agent requires agent", () => {
    assert.deepEqual(TOOL_KILL_AGENT.inputSchema.required, ["agent"]);
  });

  it("list_agents has no required params", () => {
    assert.equal(TOOL_LIST_AGENTS.inputSchema.required, undefined);
  });

  it("MCP_SERVER_INFO has name and version", () => {
    assert.equal(MCP_SERVER_INFO.name, "autonomos");
    assert.ok(MCP_SERVER_INFO.version);
  });

  it("MCP_INSTRUCTIONS mentions all tools", () => {
    assert.ok(MCP_INSTRUCTIONS.includes("send"));
    assert.ok(MCP_INSTRUCTIONS.includes("list_agents"));
    assert.ok(MCP_INSTRUCTIONS.includes("create_agent"));
    assert.ok(MCP_INSTRUCTIONS.includes("kill_agent"));
    assert.ok(MCP_INSTRUCTIONS.includes("agent://"));
    assert.ok(MCP_INSTRUCTIONS.includes("broadcast://"));
  });

  it("MCP_INSTRUCTIONS_EXTERNAL is concise (no channel details)", () => {
    assert.ok(!MCP_INSTRUCTIONS_EXTERNAL.includes("agent://"));
    assert.ok(!MCP_INSTRUCTIONS_EXTERNAL.includes("<channel>"));
  });
});
