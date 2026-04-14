import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_KILL_AGENT, TOOL_SET_MANAGER } from "../mcp/tools.js";

/**
 * Tests for MCP tool input validation — verifying that schemas
 * correctly declare the 'name' alias and don't require 'agent'.
 */

describe("MCP tool schemas — name alias support", () => {
  describe("TOOL_KILL_AGENT", () => {
    it("declares both agent and name properties", () => {
      const props = TOOL_KILL_AGENT.inputSchema.properties;
      assert.ok(props.agent, "should have agent property");
      assert.ok(props.name, "should have name property");
    });

    it("does not require agent (both params optional)", () => {
      assert.equal(
        TOOL_KILL_AGENT.inputSchema.required,
        undefined,
        "required should be undefined (neither agent nor name is required at schema level)",
      );
    });

    it("agent property has description", () => {
      const agent = TOOL_KILL_AGENT.inputSchema.properties.agent as Record<
        string,
        unknown
      >;
      assert.equal(agent.type, "string");
      assert.ok(
        typeof agent.description === "string" && agent.description.length > 0,
      );
    });

    it("name property is described as alias", () => {
      const name = TOOL_KILL_AGENT.inputSchema.properties.name as Record<
        string,
        unknown
      >;
      assert.equal(name.type, "string");
      assert.ok(
        typeof name.description === "string" &&
          name.description.toLowerCase().includes("alias"),
      );
    });
  });

  describe("TOOL_SET_MANAGER", () => {
    it("declares both agent and name properties", () => {
      const props = TOOL_SET_MANAGER.inputSchema.properties;
      assert.ok(props.agent, "should have agent property");
      assert.ok(props.name, "should have name property");
    });

    it("does not require agent (name alias available)", () => {
      assert.equal(
        TOOL_SET_MANAGER.inputSchema.required,
        undefined,
        "required should be undefined",
      );
    });

    it("still has manager property", () => {
      const props = TOOL_SET_MANAGER.inputSchema.properties;
      assert.ok(props.manager, "should have manager property");
    });
  });
});
