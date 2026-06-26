// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup-dom";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./agent-status-icon";

/**
 * agent-status-icon — the status badge shown on every agent card. The icon
 * collapses ~10 hook-derived statuses into 5 visual categories; the label
 * helper maps each status to human-readable text. These assert the
 * user-visible *behavior* (which icon category / which words) rather than SVG
 * internals.
 */
describe("agentStatusLabel", () => {
  it("maps each status to its human label", () => {
    expect(agentStatusLabel("ready")).toBe("Ready");
    expect(agentStatusLabel("working")).toBe("Working");
    expect(agentStatusLabel("idle")).toBe("Idle");
    expect(agentStatusLabel("needs_input")).toBe("Needs input");
    expect(agentStatusLabel("error")).toBe("Error");
    expect(agentStatusLabel("compacting")).toBe("Compacting");
    expect(agentStatusLabel("orchestrating")).toBe("Orchestrating");
    expect(agentStatusLabel("stopped")).toBe("Stopped");
  });

  it("includes the tool name when tool_running has a currentTool", () => {
    expect(agentStatusLabel("tool_running", "Bash")).toBe("Running Bash");
  });

  it("falls back to generic text for tool_running with no tool", () => {
    expect(agentStatusLabel("tool_running")).toBe("Running tool");
  });

  it("returns an empty string for unknown", () => {
    expect(agentStatusLabel("unknown")).toBe("");
  });
});

describe("AgentStatusIcon", () => {
  // Each category exposes a stable aria-label we can assert against.
  const cases: Array<[AgentStatus, string]> = [
    ["idle", "Idle"],
    ["ready", "Idle"], // ready + idle share the "completed" category
    ["needs_input", "Needs input"],
    ["error", "Needs input"], // error shares the "warning" category
    ["working", "Working"],
    ["tool_running", "Working"], // syncing category
    ["stopped", "Stopped"],
    ["unknown", "Unknown"],
  ];

  for (const [status, ariaLabel] of cases) {
    it(`renders the "${ariaLabel}" icon for status="${status}"`, () => {
      const { container } = render(<AgentStatusIcon status={status} />);
      const svg = container.querySelector(`svg[aria-label="${ariaLabel}"]`);
      expect(svg).not.toBeNull();
    });
  }

  it("honors the size prop on the wrapper", () => {
    const { container } = render(<AgentStatusIcon status="idle" size={20} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveStyle({ width: "20px", height: "20px" });
  });
});
