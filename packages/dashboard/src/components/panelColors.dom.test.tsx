// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { THEMES, useStore } from "../store";
import { PresetsPanel } from "./PresetsPanel";
import { SchedulesPanel } from "./SchedulesPanel";

// getSnapshot must return a REFERENCE-STABLE object (useSyncExternalStore).
const presetsSnapshot = {
  data: {
    demo: {
      name: "demo",
      env: { MODEL: "m" },
      secretKeys: ["TOKEN"],
      secrets: {},
    },
  },
  error: null,
};
const schedulesSnapshot = {
  data: {
    schedules: {
      nightly: {
        name: "nightly",
        schedule: "0 9 * * *",
        target: "agent:helper",
        prompt: "hi",
        enabled: false,
        state: { runCount: 0 },
      },
    },
    scheduler: { activeRuns: 0, queuedRuns: 0, maxConcurrentRuns: 3 },
  },
  error: null,
};
vi.mock("../api/polls", () => ({
  presetsPoll: {
    subscribe: () => () => {},
    getSnapshot: () => presetsSnapshot,
    refresh: vi.fn(async () => {}),
  },
  schedulesPoll: {
    subscribe: () => () => {},
    getSnapshot: () => schedulesSnapshot,
    refresh: vi.fn(async () => {}),
  },
}));
vi.mock("../api/config", () => ({ presetsApi: {} }));
vi.mock("../api/schedules", () => ({ schedulesApi: {} }));

/** jsdom normalizes inline colors to rgb(); compare in that form. */
function rgb(hex: string): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) =>
    Number.parseInt(h.slice(i, i + 2), 16),
  );
  return `rgb(${r}, ${g}, ${b})`;
}

const CREAM = rgb("#e6e1cf");
const NAVY_CARD = "rgba(28, 36, 51, 0.6)";

/** The nearest ancestor with an inline background (the card). */
function cardOf(el: HTMLElement): HTMLElement {
  let cur: HTMLElement | null = el;
  while (cur && !cur.style.borderRadius) cur = cur.parentElement;
  if (!cur) throw new Error("no card ancestor");
  return cur;
}

afterEach(() => {
  useStore.setState({ theme: "void" });
});

describe.each([
  ["Presets", PresetsPanel, "demo"],
  ["Schedules", SchedulesPanel, "nightly"],
] as const)("%s panel colors follow the theme", (heading, Panel, cardName) => {
  it("Daylight: dark title text and a light card", () => {
    useStore.setState({ theme: "daylight" });
    render(<Panel />);
    const h = screen.getByRole("heading", { name: heading });
    expect(h.style.color).toBe(rgb(THEMES.daylight.page.fg));
    expect(h.style.color).not.toBe(CREAM);
    const card = cardOf(screen.getByText(cardName));
    expect(card.style.background).not.toBe(NAVY_CARD);
    expect(card.style.background).toBe("rgb(255, 255, 255)");
  });

  it("dark themes keep the exact previous colors", () => {
    for (const theme of ["void", "midnight"] as const) {
      useStore.setState({ theme });
      const { unmount } = render(<Panel />);
      expect(screen.getByRole("heading", { name: heading }).style.color).toBe(
        CREAM,
      );
      expect(cardOf(screen.getByText(cardName)).style.background).toBe(
        NAVY_CARD,
      );
      unmount();
    }
  });
});
