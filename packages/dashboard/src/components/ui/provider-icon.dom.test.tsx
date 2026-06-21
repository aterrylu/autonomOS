// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup-dom";
import type { AgentStatus } from "./agent-status-icon";
import { ProviderAgentIcon, ProviderIcon } from "./provider-icon";

/**
 * provider-icon — the "Provider + status" agent icon. The provider's official
 * mark is the main glyph; status rides in a corner badge. These assert the
 * user-visible behavior (which provider mark, which status badge) via stable
 * aria-labels rather than SVG path internals.
 */
describe("ProviderIcon", () => {
  const cases: Array<[string | undefined, string]> = [
    ["claude-code", "Claude"],
    ["codex", "Codex"],
    ["gemini-cli", "Gemini"],
    ["something-else", "Agent"], // unknown → neutral fallback glyph
    [undefined, "Agent"],
  ];

  for (const [provider, ariaLabel] of cases) {
    it(`renders the "${ariaLabel}" mark for provider="${provider}"`, () => {
      const { container } = render(<ProviderIcon provider={provider} />);
      expect(
        container.querySelector(`svg[aria-label="${ariaLabel}"]`),
      ).not.toBeNull();
    });
  }
});

describe("ProviderAgentIcon", () => {
  // The provider mark and the status corner badge both render, each with its
  // own aria-label. Status collapses into the same categories as AgentStatusIcon.
  const statusCases: Array<[AgentStatus, string]> = [
    ["idle", "Idle"],
    ["working", "Working"],
    ["needs_input", "Needs input"],
    ["stopped", "Stopped"],
    ["unknown", "Unknown"],
  ];

  for (const [status, badgeLabel] of statusCases) {
    it(`shows the provider mark + "${badgeLabel}" badge for status="${status}"`, () => {
      const { container } = render(
        <ProviderAgentIcon provider="codex" status={status} />,
      );
      expect(container.querySelector('svg[aria-label="Codex"]')).not.toBeNull();
      expect(
        container.querySelector(`svg[aria-label="${badgeLabel}"]`),
      ).not.toBeNull();
    });
  }

  it("honors the size prop on the wrapper", () => {
    const { container } = render(
      <ProviderAgentIcon provider="claude-code" status="idle" size={22} />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveStyle({ width: "22px", height: "22px" });
  });
});
