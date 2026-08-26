// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Status-label styling wired into a real SessionRow: active-work labels get the
 * `.status-shimmer` class; other statuses get a static muted-accent inline color;
 * and the treatment coexists with the shipped recency fade (which fades the
 * TIMESTAMP, not the label). The pure mapping is covered in statusLabelStyle.test.ts.
 */

const NOW = Date.now();
const DAY = 86_400_000;
function sess(id: string, ageMs = 60_000): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    claudeSessionId: id,
    createdAt: NOW - ageMs,
    updatedAt: NOW - ageMs,
  };
}

const WORKER = sess("worker");
const BLOCKED = sess("blocked");
const DEAD = sess("dead", 34 * DAY); // ancient timestamp → recency fade at 0.52 (void)
const AGENTS = [WORKER, BLOCKED, DEAD];

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
    agentStatuses: {
      worker: { status: "working" },
      blocked: { status: "needs_input" },
      dead: { status: "stopped" },
    },
    pinnedOrder: [],
    unpinnedOrder: ["worker", "blocked", "dead"],
    theme: "void",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar status label styling", () => {
  it("active-work label (Working) gets the shimmer class, no inline color", async () => {
    render(<Sidebar />);
    const label = await screen.findByText("Working");
    expect(label).toHaveClass("status-shimmer");
  });

  it("needs_input label is amber and does NOT shimmer", async () => {
    render(<Sidebar />);
    const label = await screen.findByText("Needs input");
    expect(label).not.toHaveClass("status-shimmer");
    expect(label).toHaveStyle({ color: "rgb(234, 179, 8)" }); // #eab308
  });

  it("stopped label is neutral gray", async () => {
    render(<Sidebar />);
    const label = await screen.findByText("Stopped");
    expect(label).toHaveStyle({ color: "rgb(163, 163, 163)" }); // #a3a3a3
  });

  it("coexists with recency: ancient row's timestamp fades, but its status label keeps full color", async () => {
    render(<Sidebar />);
    // DEAD is 34d old → the recency treatment fades its TIMESTAMP…
    const age = await screen.findByText("34d");
    expect(age).toHaveStyle({ opacity: "0.52" });
    // …while its "Stopped" LABEL stays full-strength gray (orthogonal signals).
    const label = await screen.findByText("Stopped");
    expect(label).toHaveStyle({ color: "rgb(163, 163, 163)" });
  });
});

describe("Sidebar status label styling — light theme uses the darkened palette", () => {
  beforeEach(() => {
    useStore.setState({ theme: "daylight" });
  });

  it("active-work uses the LIGHT shimmer class (not the dark one)", async () => {
    render(<Sidebar />);
    const label = await screen.findByText("Working");
    expect(label).toHaveClass("status-shimmer-light");
    expect(label).not.toHaveClass("status-shimmer");
  });

  it("needs_input uses the darkened amber legible on white", async () => {
    render(<Sidebar />);
    const label = await screen.findByText("Needs input");
    expect(label).toHaveStyle({ color: "rgb(138, 105, 0)" }); // #8a6900
  });

  it("stopped uses the darkened gray legible on white", async () => {
    render(<Sidebar />);
    const label = await screen.findByText("Stopped");
    expect(label).toHaveStyle({ color: "rgb(107, 113, 120)" }); // #6b7178
  });
});
