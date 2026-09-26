// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup-dom";
import { act } from "@testing-library/react";
import codexIconUrl from "../../assets/provider-icons/codex-openai.png";
import { useStore } from "../../store";
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
        container.querySelector(
          `svg[aria-label="${ariaLabel}"], img[alt="${ariaLabel}"]`,
        ),
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
      expect(container.querySelector('img[alt="Codex"]')).not.toBeNull();
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

describe("provider marks render in their CANONICAL form on every theme", () => {
  // Brand policy (NOTICE): marks are unaltered. Codex is OpenAI's own published
  // icon (a white Blossom on a black tile), the SAME image in every theme, and
  // never recolored, filtered, rounded or dimmed. Claude keeps its brand clay.
  const codexImg = () => {
    const { container, unmount } = render(<ProviderIcon provider="codex" />);
    const img = container.querySelector('img[alt="Codex"]') as HTMLImageElement;
    const seen = {
      src: img.getAttribute("src"),
      style: img.getAttribute("style") ?? "",
    };
    unmount();
    return seen;
  };
  const claudeColor = () => {
    const { container, unmount } = render(
      <ProviderIcon provider="claude-code" />,
    );
    const c = (
      container.querySelector('svg[aria-label="Claude"]') as SVGElement
    ).style.color;
    unmount();
    return c;
  };

  for (const theme of ["daylight", "midnight", "void"] as const) {
    it(`${theme}: Codex is OpenAI's official icon, untouched; Claude is its brand clay`, () => {
      act(() => useStore.setState({ theme }));
      const codex = codexImg();
      expect(codex.src).toBe(codexIconUrl);
      // Layout only: nothing that could alter how the asset looks.
      expect(codex.style).not.toMatch(
        /color|filter|opacity|border-radius|mix-blend|background/,
      );
      expect(claudeColor()).toBe("rgb(217, 119, 87)");
    });
  }

  it("the Codex asset is byte-identical to the one OpenAI publishes (README hash)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../assets");
    const bytes = readFileSync(join(dir, "provider-icons/codex-openai.png"));
    const readme = readFileSync(join(dir, "provider-icons/README.md"), "utf8");
    const documented = /sha256 `([0-9a-f]{64})`/.exec(readme)?.[1];
    expect(documented).toBeDefined();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(documented);
  });
});
