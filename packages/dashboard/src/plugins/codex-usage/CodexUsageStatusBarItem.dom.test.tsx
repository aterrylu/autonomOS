// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { CodexUsageStatusBarItem } from "./CodexUsageStatusBarItem";
import type { CodexUsageData } from "./types";

/**
 * CodexUsageStatusBarItem — the bottom-bar Codex summary. Unlike the Claude
 * item it renders NOTHING when there's no Codex signal (needsData) or while the
 * first poll is still racing, so non-Codex users never see a nag. Once real
 * windows arrive it shows "<label> <pct>%".
 */

function stubUsage(body: CodexUsageData | null): void {
  // REAL Response objects: the api client core reads res.text(), which the
  // old {json} fake lacked — data silently stayed null.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/api/plugins/codex-usage")) {
        return Promise.resolve(
          new Response(JSON.stringify(body ?? { error: "boom" }), {
            status: body !== null ? 200 : 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
}

async function renderSettled() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CodexUsageStatusBarItem />);
  });
  // Flush the mount-time fetch promise chain.
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

const liveData: CodexUsageData = {
  secondary: { usedPercent: 9, windowMinutes: 300, resetsAt: null },
  primary: { usedPercent: 71, windowMinutes: 10_080, resetsAt: null },
  additionalLimits: [],
  credits: null,
  planType: "pro",
  account: { email: "t@example.com", planType: "pro" },
  source: "live",
  fetchedAt: new Date().toISOString(),
};

describe("CodexUsageStatusBarItem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing when there is no Codex signal (needsData)", async () => {
    stubUsage({
      ...liveData,
      secondary: null,
      primary: null,
      needsData: true,
    });
    const { container } = await renderSettled();
    expect(container.textContent).toBe("");
  });

  it("shows the window summary when live data is present", async () => {
    stubUsage(liveData);
    const { container } = await renderSettled();
    expect(container.textContent).toContain("5h");
    expect(container.textContent).toContain("9%");
    expect(container.textContent).toContain("7d");
    expect(container.textContent).toContain("71%");
  });

  it("surfaces a named lane in the bar by its display name when it exceeds the headline", async () => {
    // Pro 5x shape: weekly-only headline; Luna Reserve hotter than it.
    stubUsage({
      ...liveData,
      secondary: null,
      primary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: null },
      additionalLimits: [
        {
          id: "codex-base-model-inference",
          name: "Luna Reserve",
          description: "Fallback lane",
          primary: { usedPercent: 63, windowMinutes: 10_080, resetsAt: null },
          secondary: null,
        },
      ],
    });
    const { container } = await renderSettled();
    expect(container.textContent).toContain("Luna Reserve");
    expect(container.textContent).toContain("63%");
    expect(container.textContent).not.toContain("gpt-reserve");
  });

  it("FUTURE-SAFETY: an unmapped lane with a long name is capped in width, not dropped", async () => {
    const longName = "GPT-12-Hyperextended-Codex-Model-Preview-Lane-Name";
    stubUsage({
      ...liveData,
      additionalLimits: [
        {
          id: "codex-long",
          name: longName,
          primary: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
          secondary: null,
        },
      ],
    });
    const { container } = await renderSettled();
    const label = container.querySelector(`[title="${longName}: 99% used"]`);
    expect(label).not.toBeNull();
    const text = label?.querySelector(".truncate") as HTMLElement | null;
    expect(text?.style.maxWidth).toBe("120px");
    expect(container.textContent).toContain("99%");
  });

  it("renders nothing while the first poll is still loading", async () => {
    // A fetch that never resolves → data stays null → item stays hidden.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { container } = await renderSettled();
    expect(container.textContent).toBe("");
  });
});
