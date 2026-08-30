// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

const NOW = Date.now();
function sess(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "gemini-cli",
    claudeSessionId: id,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const WITH = sess("gigi", { pendingHandoffCount: 3 });
const WITHOUT = sess("cato");
const AGENTS = [WITH, WITHOUT];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      if (u.includes("/api/agents") && !u.includes("/tree")) body = AGENTS;
      else if (u.includes("/api/agents") || u.includes("/api/projects"))
        body = [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
}

beforeEach(() => {
  stubFetch();
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions: AGENTS,
    exitedSessions: [],
    projects: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState({ sessions: [] });
});

describe("Sidebar — hand-off pending badge", () => {
  it("shows the pill ONLY for an agent with a non-empty queue", () => {
    render(<Sidebar />);
    // gigi has 3 queued → exactly one badge, labelled by its title.
    const badges = screen.queryAllByTitle(/queued for hand-delivery/);
    expect(badges.length).toBe(1);
    expect(badges[0].textContent?.replace(/\s+/g, " ").trim()).toBe("✉ 3");
  });

  it("singularizes the title for a single queued message", () => {
    useStore.setState({ sessions: [sess("solo", { pendingHandoffCount: 1 })] });
    render(<Sidebar />);
    expect(
      screen.getByTitle("1 message queued for hand-delivery"),
    ).toBeTruthy();
  });
});
