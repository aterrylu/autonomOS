// @vitest-environment jsdom
/**
 * REGRESSION GUARD (Terry's standing rule: a user-visible fix ships its own CI
 * guard). The symptom: "the Codex icon gets grayed", then the cloud swapped for
 * another mark. On EVERY surface that draws a Codex agent (sidebar agent row,
 * Projects row, Org Chart card, Codex usage bar) and on every theme, the mark
 * must be the cloud path, always the same white, and never dimmed by anything
 * around it.
 */
import { createHash } from "node:crypto";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { CodexUsageStatusBarItem } from "../plugins/codex-usage/CodexUsageStatusBarItem";
import type { CodexUsageData } from "../plugins/codex-usage/types";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";
import { Sidebar } from "./Sidebar";

const CLOUD_SHA256 =
  "667c7f51889219b60d4b67260502b52583a29c188bde0c38fe5ac0123ce30f76";
const WHITE = "rgb(240, 246, 252)";
const THEMES = ["daylight", "midnight", "void"] as const;

/** Every Codex mark under `root`: the cloud, the white, nothing dimming it. */
function expectCanonicalCodex(root: ParentNode, where: string): number {
  const marks = [...root.querySelectorAll('svg[aria-label="Codex"]')];
  for (const svg of marks) {
    const d = svg.querySelector("path")?.getAttribute("d") ?? "";
    expect(createHash("sha256").update(d).digest("hex"), `${where}: path`).toBe(
      CLOUD_SHA256,
    );
    expect((svg as SVGElement).style.color, `${where}: color`).toBe(WHITE);
    for (let el: Element | null = svg; el; el = el.parentElement) {
      const cls = el.getAttribute("class") ?? "";
      const style = el.getAttribute("style") ?? "";
      expect(cls, `${where}: dimming class on an ancestor`).not.toMatch(
        /(^|\s)opacity-(?!100)/,
      );
      expect(style, `${where}: inline dim on an ancestor`).not.toMatch(
        /opacity:\s*0|filter:/,
      );
    }
  }
  return marks.length;
}

const NOW = Date.now();
const codexSession = {
  id: "cdx-1",
  claudeSessionId: "cdx-1",
  name: "api-dev",
  status: "running",
  workingDirectory: "/work/demo",
  provider: "codex",
  createdAt: NOW - 60_000,
  updatedAt: NOW,
} as never;
const codexProject = {
  path: "/work/demo",
  name: "demo",
  kind: "repo",
  lastActive: NOW,
  counts: { visible: 2, headless: 0, removed: 0 },
  sessions: [
    // a live row and an EXITED one: the exited row dims its text column, and
    // that must never reach the mark
    {
      sessionId: "cdx-1",
      summary: "api-dev",
      lastModified: NOW,
      provider: "codex",
    },
    {
      sessionId: "cdx-old",
      summary: "old run",
      lastModified: NOW - 3_600_000,
      provider: "codex",
      autonomosStatus: "exited",
    },
  ],
} as never;
const usage: CodexUsageData = {
  secondary: { usedPercent: 9, windowMinutes: 300, resetsAt: null },
  primary: { usedPercent: 71, windowMinutes: 10_080, resetsAt: null },
  additionalLimits: [],
  credits: null,
  planType: "pro",
  account: { email: "t@example.com", planType: "pro" },
  source: "live",
  fetchedAt: new Date().toISOString(),
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const u = String(url);
      let body: unknown = [];
      if (u.includes("/api/plugins/codex-usage")) body = usage;
      else if (u.includes("/api/agents/tree"))
        body = [
          {
            id: "cdx-1",
            claudeSessionId: "cdx-1",
            name: "api-dev",
            status: "running",
            provider: "codex",
            children: [],
          },
        ];
      else if (u.includes("/api/projects")) body = [codexProject];
      else if (u.includes("/api/agents")) body = [codexSession];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

beforeEach(() => {
  stubFetch();
  localStorage.clear();
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    agentIconStyle: "provider",
    sessions: [codexSession],
    exitedSessions: [],
    projects: [codexProject],
    expandedProjects: { "/work/demo": true },
    agentStatuses: {},
    notificationCounts: {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({ sessions: [], projects: [], expandedProjects: {} });
});

describe("the Codex mark on every surface: the white cloud, never dimmed", () => {
  for (const theme of THEMES) {
    it(`${theme}: sidebar agent row + Projects rows (live and exited)`, () => {
      act(() => useStore.setState({ theme }));
      const { container } = render(<Sidebar />);
      // 1 agent row + 2 Projects rows
      expect(expectCanonicalCodex(container, `${theme} sidebar`)).toBe(3);
    });

    it(`${theme}: Org Chart card`, async () => {
      act(() => useStore.setState({ theme }));
      render(<HierarchyPanel />);
      const card = await waitFor(() => {
        const el = document.querySelector('[data-org-card="cdx-1"]');
        if (!el) throw new Error("card not rendered yet");
        return el;
      });
      expect(expectCanonicalCodex(card, `${theme} org card`)).toBe(1);
    });

    it(`${theme}: Codex usage bar`, async () => {
      act(() => useStore.setState({ theme }));
      let container!: HTMLElement;
      await act(async () => {
        container = render(<CodexUsageStatusBarItem />).container;
      });
      await waitFor(() => {
        if (!container.querySelector('svg[aria-label="Codex"]'))
          throw new Error("usage item not rendered yet");
      });
      expect(expectCanonicalCodex(container, `${theme} usage bar`)).toBe(1);
    });
  }
});
