// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup-dom";
import { treeLineGuidesPropsEqual } from "../Sidebar";
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

/**
 * Render fan-out guards. These assert that the two EXPORTED icons are
 * React.memo-wrapped (structurally) and that TreeLineGuides' comparator
 * compares by value. They do not prove renders are skipped: that is measured
 * by the browser render probe (185 → ~46 renders per status frame). The
 * unexported StatusCorner / MonochromeMark wrappers are covered only by it.
 */
describe("render fan-out: memoized leaf visuals", () => {
  it("the provider/status icons are React.memo components", () => {
    const memo = Symbol.for("react.memo");
    for (const c of [ProviderAgentIcon, ProviderIcon]) {
      expect((c as unknown as { $$typeof: symbol }).$$typeof).toBe(memo);
    }
  });

  it("treeLineGuidesPropsEqual compares ancestorIsLast BY VALUE (it's rebuilt every render)", () => {
    const base = {
      depth: 2,
      isLastChild: false,
      ancestorIsLast: [false, true],
      lineColor: "#333",
    };
    expect(
      treeLineGuidesPropsEqual(base, {
        ...base,
        ancestorIsLast: [false, true],
      }),
    ).toBe(true);
    expect(
      treeLineGuidesPropsEqual(base, { ...base, ancestorIsLast: [true, true] }),
    ).toBe(false);
    expect(
      treeLineGuidesPropsEqual(base, { ...base, ancestorIsLast: [false] }),
    ).toBe(false);
    expect(treeLineGuidesPropsEqual(base, { ...base, depth: 3 })).toBe(false);
    expect(treeLineGuidesPropsEqual(base, { ...base, isLastChild: true })).toBe(
      false,
    );
    expect(treeLineGuidesPropsEqual(base, { ...base, lineColor: "#444" })).toBe(
      false,
    );
  });
});
