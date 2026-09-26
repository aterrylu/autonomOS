// @vitest-environment jsdom
import type { AgentActivityBatch, AgentTreeNode } from "@autonomos/core";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { orgTreePoll } from "../api/polls";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";
import { identiconCells } from "./orgchart/Identicon";

/**
 * The Balanced card (Terry's pick): identicon + provider badge, name + unread
 * pill, a pulsing dot + the live action + time in state, and a thin 24h strip.
 * Every field is a real reading or absent; the strip comes from ONE batched
 * request for the whole fleet.
 */

const NOW = Date.now();
const MIN = 60_000;
let batch: unknown = null;
let fetched: string[] = [];

function stub(tree: AgentTreeNode[]) {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      if (url.includes("/api/agents/tree"))
        return Promise.resolve(
          new Response(JSON.stringify(tree), { status: 200 }),
        );
      if (/\/api\/agents\/analytics(\?|$)/.test(url))
        return Promise.resolve(
          new Response(JSON.stringify(batch), { status: 200 }),
        );
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
}
const node = (
  id: string,
  extra: Partial<AgentTreeNode> = {},
  children: AgentTreeNode[] = [],
): AgentTreeNode =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    provider: "claude-code",
    children,
    ...extra,
  }) as AgentTreeNode;
const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    workingDirectory: `/w/${id}`,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW,
    lastActivityAt: NOW - 30 * MIN,
    provider: "claude-code",
    ...extra,
  }) as never;

const card = (id: string) =>
  document.querySelector(`[data-org-card="${id}"]`) as HTMLElement | null;
const $in = (id: string, sel: string) =>
  card(id)?.querySelector(sel) as HTMLElement | null;

beforeEach(() => {
  batch = null;
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

async function mount(
  tree: AgentTreeNode[],
  state: Parameters<typeof useStore.setState>[0],
) {
  stub(tree);
  useStore.setState({
    theme: "void",
    exitedSessions: [],
    notificationCounts: {},
    agentStatuses: {},
    ...(state as object),
  });
  await act(async () => {
    await orgTreePoll.refresh();
  });
  render(<HierarchyPanel />);
  await waitFor(() => expect(card(tree[0].id)).not.toBeNull());
}

const fleetBatch = (
  agents: AgentActivityBatch["agents"],
): AgentActivityBatch => ({ since: NOW - 120 * MIN, maxSegments: 48, agents });

describe("Balanced card", () => {
  it("the whole fleet's strips come from ONE batched request, never one per card", async () => {
    batch = fleetBatch({});
    await mount([node("Lead", {}, [node("A"), node("B"), node("C")])], {
      sessions: ["Lead", "A", "B", "C"].map((i) => session(i)),
    });
    await waitFor(() =>
      expect(fetched.some((u) => /\/api\/agents\/analytics$/.test(u))).toBe(
        true,
      ),
    );
    expect(
      fetched.filter((u) => /\/api\/agents\/[^/]+\/analytics/.test(u)),
    ).toEqual([]);
    expect(
      fetched.filter((u) => /\/api\/agents\/analytics/.test(u)).length,
    ).toBe(1);
  });

  it("the strip draws the batch's history and its last state runs to NOW (no empty band)", async () => {
    batch = fleetBatch({
      A: {
        status: { current: "working", since: NOW - 10 * MIN },
        activity: [
          { from: NOW - 40 * MIN, to: NOW - 10 * MIN, status: "idle" },
          // The server's clock at fetch time: 5 minutes behind the client.
          { from: NOW - 10 * MIN, to: NOW - 5 * MIN, status: "working" },
        ],
      },
    });
    await mount([node("A")], {
      sessions: [session("A")],
      agentStatuses: { A: { status: "working" } as never },
    });
    await waitFor(() =>
      expect($in("A", "[data-org-card-strip]")).not.toBeNull(),
    );
    const segs = [
      ...(card("A")?.querySelectorAll("[data-org-card-segment]") ?? []),
    ] as HTMLElement[];
    expect(segs.map((s) => s.dataset.orgCardSegment)).toEqual([
      "idle",
      "working",
    ]);
    const last = segs.at(-1) as HTMLElement;
    expect(
      Number.parseFloat(last.style.left) + Number.parseFloat(last.style.width),
    ).toBeCloseTo(100, 0);
  });

  it("time in state when the batch knows it; otherwise the last-active age, labelled as such", async () => {
    batch = fleetBatch({
      A: { status: { current: "idle", since: NOW - 12 * MIN }, activity: [] },
    });
    await mount([node("Lead", {}, [node("A"), node("B")])], {
      sessions: ["Lead", "A", "B"].map((i) => session(i)),
    });
    await waitFor(() =>
      expect($in("A", "[data-org-age]")?.dataset.orgAge).toBe("in-state"),
    );
    expect($in("A", "[data-org-age]")?.textContent).toBe("12m");
    // B has no history: the last-active age, with an honest title.
    const b = $in("B", "[data-org-age]") as HTMLElement;
    expect(b.dataset.orgAge).toBe("last-active");
    expect(b.title).toMatch(/^Last active /);
  });

  it("a working Codex agent reads 'Working' — never a guessed tool", async () => {
    batch = fleetBatch({});
    await mount([node("Cx", { provider: "codex" })], {
      sessions: [session("Cx", { provider: "codex" })],
      agentStatuses: { Cx: { status: "working" } as never },
    });
    expect($in("Cx", "[data-org-label]")?.textContent).toBe("Working");
  });

  it("the dot pulses while working or waiting on you, not at rest", async () => {
    batch = fleetBatch({});
    await mount([node("Lead", {}, [node("W"), node("N"), node("I")])], {
      sessions: ["Lead", "W", "N", "I"].map((i) => session(i)),
      agentStatuses: {
        W: { status: "working" } as never,
        N: { status: "needs_input" } as never,
        I: { status: "idle" } as never,
      },
    });
    expect($in("W", "[data-org-pulse]")).not.toBeNull();
    expect($in("N", "[data-org-pulse]")).not.toBeNull();
    expect($in("I", "[data-org-pulse]")).toBeNull();
  });

  it("identicons are seeded by ID, so two agents with the same NAME still look different", async () => {
    batch = fleetBatch({});
    await mount(
      [
        node("id-aaa", { name: "Twin" }),
        node("id-zzz-other", { name: "Twin" }),
      ],
      {
        sessions: [
          session("id-aaa", { name: "Twin" }),
          session("id-zzz-other", { name: "Twin" }),
        ],
      },
    );
    expect($in("id-aaa", "[data-org-identicon]")?.dataset.orgIdenticon).toBe(
      "id-aaa",
    );
    expect(JSON.stringify(identiconCells("id-aaa"))).not.toBe(
      JSON.stringify(identiconCells("id-zzz-other")),
    );
  });

  it("an exited ghost keeps Resume and draws no strip", async () => {
    batch = fleetBatch({
      Gone: {
        status: { current: "stopped", since: NOW - 5 * MIN },
        activity: [{ from: NOW - 30 * MIN, to: NOW, status: "stopped" }],
      },
    });
    await mount(
      [node("Lead", {}, [node("Live"), node("Gone", { status: "exited" })])],
      {
        sessions: ["Lead", "Live"].map((i) => session(i)),
        exitedSessions: [session("Gone", { status: "exited" })],
      },
    );
    // Exited agents hide unless shown; the ghost appears with "Show N exited".
    const toggle = [...document.querySelectorAll("button")].find((b) =>
      /Show \d+ exited/.test(b.textContent ?? ""),
    );
    act(() => toggle?.click());
    await waitFor(() => expect(card("Gone")).not.toBeNull());
    expect(card("Gone")?.textContent).toContain("Resume");
    expect($in("Gone", "[data-org-card-strip]")).toBeNull();
  });

  it("a malformed batch never blanks the cards (no strip, nothing thrown)", async () => {
    batch = { nope: true };
    await mount([node("A")], { sessions: [session("A")] });
    await new Promise((r) => setTimeout(r, 50));
    expect(card("A")).not.toBeNull();
    expect($in("A", "[data-org-card-strip]")).toBeNull();
  });

  it("a status change refetches the batch (debounced), once", async () => {
    batch = fleetBatch({});
    await mount([node("A")], {
      sessions: [session("A")],
      agentStatuses: { A: { status: "idle" } as never },
    });
    const count = () =>
      fetched.filter((u) => /\/api\/agents\/analytics/.test(u)).length;
    await waitFor(() => expect(count()).toBe(1));
    act(() => {
      useStore.setState({
        agentStatuses: { A: { status: "working" } as never },
      });
    });
    await waitFor(() => expect(count()).toBe(2), { timeout: 2000 });
  });
});
