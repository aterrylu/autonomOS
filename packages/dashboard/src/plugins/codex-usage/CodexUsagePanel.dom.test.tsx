// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup-dom";
import { CodexUsagePanel } from "./CodexUsagePanel";
import type { CodexNamedLimit, CodexUsageData } from "./types";

/**
 * CodexUsagePanel — the expanded popover. Pins the future-safety contract on
 * the RENDER side: every named limit the server sends shows up as its own
 * row with label + explainer, including one with a name nobody has mapped,
 * and a long name is ellipsized (full text kept in the title) rather than
 * widening the panel.
 */

const spark: CodexNamedLimit = {
  id: "codex-codex-bengalfox",
  name: "GPT-5.3-Codex-Spark",
  description: "Separate model with its own usage meters",
  meteredFeature: "codex_bengalfox",
  primary: { usedPercent: 12, windowMinutes: 300, resetsAt: null },
  secondary: { usedPercent: 8, windowMinutes: 10_080, resetsAt: null },
};

const reserve: CodexNamedLimit = {
  id: "codex-base-model-inference",
  name: "Luna Reserve",
  description:
    "Fallback lane · GPT-5.6 Luna, used once ordinary usage runs out",
  meteredFeature: "base_model_inference",
  primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: null },
  secondary: null,
};

const proliteData: CodexUsageData = {
  secondary: null,
  primary: { usedPercent: 34, windowMinutes: 10_080, resetsAt: null },
  additionalLimits: [spark, reserve],
  credits: { hasCredits: false, unlimited: false, balance: 0 },
  planType: "prolite",
  account: { email: "t@example.com", planType: "prolite" },
  source: "live",
  fetchedAt: new Date().toISOString(),
};

function renderPanel(data: CodexUsageData) {
  return render(<CodexUsagePanel data={data} onClose={() => {}} />);
}

describe("CodexUsagePanel — Pro 5x plan", () => {
  it("shows the marketing plan name and the Codex-CLI labels with explainers", () => {
    const { container, getByText, getAllByTestId } = renderPanel(proliteData);
    expect(getByText("Pro 5x")).toBeTruthy();
    expect(container.textContent).not.toContain("Prolite");
    expect(getAllByTestId("codex-named-limit")).toHaveLength(2);
    expect(getByText("GPT-5.3-Codex-Spark")).toBeTruthy();
    expect(getByText("Luna Reserve")).toBeTruthy();
    expect(getByText(/Fallback lane/)).toBeTruthy();
    // Headline is weekly-only on this plan: one Weekly row above the lanes,
    // plus Spark's weekly — never a phantom "Session" for the missing 5h.
    expect(container.textContent).toContain("Weekly");
  });

  it("FUTURE-SAFETY: an unmapped lane renders as its own row and counts", () => {
    const novel: CodexNamedLimit = {
      id: "codex-omega-inference",
      name: "GPT-9 Omega Preview",
      description: "Additional usage lane",
      primary: { usedPercent: 42, windowMinutes: 1_440, resetsAt: null },
      secondary: null,
    };
    const { getAllByTestId, getByText } = renderPanel({
      ...proliteData,
      additionalLimits: [spark, reserve, novel],
    });
    expect(getAllByTestId("codex-named-limit")).toHaveLength(3);
    expect(getByText("GPT-9 Omega Preview")).toBeTruthy();
    expect(getByText("Additional usage lane")).toBeTruthy();
    expect(getByText("42% used")).toBeTruthy();
  });

  it("ellipsizes a long lane name instead of widening the panel, keeping the full text in the title", () => {
    const longName =
      "GPT-12-Hyperextended-Codex-Model-With-An-Extremely-Long-Marketing-Name-Preview";
    const { getByTitle } = renderPanel({
      ...proliteData,
      additionalLimits: [{ ...reserve, id: "codex-long", name: longName }],
    });
    const label = getByTitle(longName);
    expect(label.className).toContain("truncate");
    expect(label.textContent).toBe(longName);
  });

  it("still renders an unknown plan id rather than hiding the pill", () => {
    const { getByText } = renderPanel({
      ...proliteData,
      planType: "ultra_workspace",
      account: { planType: "ultra_workspace" },
    });
    expect(getByText("Ultra Workspace")).toBeTruthy();
  });
});
