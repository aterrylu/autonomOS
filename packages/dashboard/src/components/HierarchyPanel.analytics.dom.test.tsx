// @vitest-environment jsdom
import type { AgentAnalytics, AgentTreeNode } from "@autonomos/core";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";
import { formatDuration } from "./orgchart/Inspector";

/**
 * The rich inspector: analytics sections fed by GET /api/agents/:id/analytics.
 * Every number shown is a server count; a field the runtime can't report reads
 * "n/a for <runtime>", never a zero.
 */

const NOW = Date.now();
const MIN = 60_000;

function analytics(over: Partial<AgentAnalytics> = {}): AgentAnalytics {
  return {
    since: NOW - 60 * MIN,
    startedAt: NOW - 42 * MIN,
    status: { current: "needs_input", since: NOW - 4 * MIN },
    turns: 7,
    waits: { count: 3, totalMs: 11 * MIN, waitingSince: NOW - 4 * MIN },
    tools: [
      { name: "Bash", count: 12 },
      { name: "Edit", count: 5 },
    ],
    toolCalls: 17,
    failedTools: 2,
    lastTool: { name: "Bash", at: NOW - 40_000 },
    restarts: 1,
    crashes: 1,
    lastExitCode: 137,
    activity: [
      { from: NOW - 50 * MIN, to: NOW - 20 * MIN, status: "working" },
      { from: NOW - 20 * MIN, to: NOW - 4 * MIN, status: "idle" },
      { from: NOW - 4 * MIN, to: NOW, status: "needs_input" },
    ],
    branch: "terry/cards",
    support: { tools: true, needsInput: true, failedTools: true },
    ...over,
  };
}

let byAgent: Record<string, AgentAnalytics> = {};
let analyticsFetches: string[] = [];

function stub(tree: AgentTreeNode[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/agents/tree"))
        return Promise.resolve(
          new Response(JSON.stringify(tree), { status: 200 }),
        );
      const m = url.match(/\/api\/agents\/([^/]+)\/analytics/);
      if (m) {
        analyticsFetches.push(m[1]);
        return Promise.resolve(
          new Response(JSON.stringify(byAgent[m[1]] ?? analytics()), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
}

const node = (id: string, provider = "claude-code"): AgentTreeNode =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    provider,
    children: [],
  }) as AgentTreeNode;

const session = (id: string, provider = "claude-code") =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    workingDirectory: `/w/${id}`,
    providerSessionId: `sess-${id}`,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW,
    provider,
  }) as never;

const card = (id: string) =>
  document.querySelector(`[data-org-card="${id}"]`) as HTMLElement;
const section = (id: string) =>
  document.querySelector(
    `[data-org-section="${id}"]`,
  ) as HTMLDetailsElement | null;

async function openInspector(id: string) {
  fireEvent.click(card(id));
  await waitFor(() =>
    expect(section("activity")?.textContent).not.toContain("Loading"),
  );
}

beforeEach(() => {
  byAgent = {};
  analyticsFetches = [];
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("rich inspector — analytics", () => {
  it("Status: time in state, uptime, waits (live), restarts and crashes with the exit code", async () => {
    stub([node("A")]);
    useStore.setState({
      theme: "void",
      sessions: [session("A")],
      exitedSessions: [],
      agentStatuses: { A: { status: "needs_input" } as never },
      notificationCounts: {},
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("A")).toBeTruthy());
    await openInspector("A");
    const st = section("status") as HTMLElement;
    expect(st).toHaveTextContent("Needs input for 4m");
    expect(st).toHaveTextContent("Up42m");
    expect(st).toHaveTextContent("3× · 11m · waiting now");
    expect(st).toHaveTextContent("Restarts1");
    expect(st).toHaveTextContent("1 · last exit code 137");
  });

  it("Activity: a 24h strip, turns, tool calls, failures, last tool and top tools", async () => {
    stub([node("A")]);
    useStore.setState({
      theme: "void",
      sessions: [session("A")],
      exitedSessions: [],
      agentStatuses: { A: { status: "idle" } as never },
      notificationCounts: {},
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("A")).toBeTruthy());
    await openInspector("A");
    const act = section("activity") as HTMLElement;
    expect(
      [...act.querySelectorAll("[data-org-segment]")].map(
        (s) => (s as HTMLElement).dataset.orgSegment,
      ),
    ).toEqual(["working", "idle", "needs_input"]);
    expect(act).toHaveTextContent("Turns7");
    expect(act).toHaveTextContent("Tool calls17");
    expect(act).toHaveTextContent("Failed tools2");
    expect(act).toHaveTextContent("Last toolBash · now");
    expect(act.querySelector("[data-org-top-tools]")).toHaveTextContent(
      "Bash12Edit5",
    );
  });

  it("a Codex agent shows n/a — never a zero — for what Codex can't report", async () => {
    stub([node("C", "codex")]);
    byAgent.C = analytics({
      tools: [],
      toolCalls: 0,
      failedTools: 0,
      lastTool: null,
      waits: { count: 0, totalMs: 0, waitingSince: null },
      support: { tools: false, needsInput: false, failedTools: false },
    });
    useStore.setState({
      theme: "void",
      sessions: [session("C", "codex")],
      exitedSessions: [],
      agentStatuses: { C: { status: "working" } as never },
      notificationCounts: {},
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("C")).toBeTruthy());
    await openInspector("C");
    const act = section("activity") as HTMLElement;
    expect(act).toHaveTextContent("Tool callsn/a for Codex");
    expect(act).toHaveTextContent("Failed toolsn/a for Codex");
    expect(act).toHaveTextContent("Last tooln/a for Codex");
    expect(act).toHaveTextContent("Turns7"); // turns ARE counted for Codex
    expect(section("status")).toHaveTextContent("Waited on youn/a for Codex");
  });

  it("Details is collapsed by default and holds branch + a copyable session id", async () => {
    stub([node("A")]);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    useStore.setState({
      theme: "void",
      sessions: [session("A")],
      exitedSessions: [],
      agentStatuses: { A: { status: "idle" } as never },
      notificationCounts: {},
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("A")).toBeTruthy());
    await openInspector("A");
    const det = section("details") as HTMLDetailsElement;
    expect(det.open).toBe(false);
    expect(det).toHaveTextContent("Branchterry/cards");
    expect(det).toHaveTextContent("sess-A");
    fireEvent.click(det.querySelector("button") as HTMLElement);
    expect(writeText).toHaveBeenCalledWith("sess-A");
  });

  it("refetches when the agent's status changes; a malformed payload renders nothing, not a crash", async () => {
    stub([node("A")]);
    useStore.setState({
      theme: "void",
      sessions: [session("A")],
      exitedSessions: [],
      agentStatuses: { A: { status: "idle" } as never },
      notificationCounts: {},
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("A")).toBeTruthy());
    await openInspector("A");
    const before = analyticsFetches.length;
    useStore.setState({ agentStatuses: { A: { status: "working" } as never } });
    await waitFor(
      () => expect(analyticsFetches.length).toBeGreaterThan(before),
      {
        timeout: 2000,
      },
    );
    // A garbage response keeps the panel alive.
    byAgent.A = { nope: true } as never;
    useStore.setState({ agentStatuses: { A: { status: "idle" } as never } });
    await new Promise((r) => setTimeout(r, 900));
    expect(section("activity")).toHaveTextContent("Loading");
  });
});

describe("formatDuration", () => {
  it("reads like a person would say it", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * MIN)).toBe("12m");
    expect(formatDuration(3 * 60 * MIN + 12 * MIN)).toBe("3h 12m");
    expect(formatDuration(3 * 60 * MIN)).toBe("3h");
    expect(formatDuration(52 * 60 * MIN)).toBe("2d 4h");
    expect(formatDuration(-1)).toBe("—");
  });
});
