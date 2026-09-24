// @vitest-environment jsdom
import type { AgentDelta, AgentTreeNode } from "@autonomos/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { agentsSocket } from "../api/agentsSocket";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";

/**
 * Message flow (PR 3): `message.routed` frames from the agent socket become
 * envelopes + speech bubbles on the chart, and the inspector reads one agent's
 * full message log on demand. Frames are injected through the socket's own
 * test hook, so the real apply path runs.
 */

type Routed = Extract<AgentDelta, { type: "message.routed" }>;
let seq = 0;
function routed(from: string | null, to: string, preview: string): Routed {
  seq += 1;
  return {
    type: "message.routed",
    id: `m${seq}`,
    from,
    fromName: from ?? "Schedule nightly",
    to,
    toName: to,
    preview,
    ts: Date.now(),
  };
}
const send = (m: Routed) => act(() => agentsSocket._applyForTests(m));

const node = (id: string, children: AgentTreeNode[] = []): AgentTreeNode =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    provider: "claude-code",
    children,
  }) as AgentTreeNode;

const session = (id: string) =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    workingDirectory: `/w/${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: "claude-code",
  }) as never;

let messagesBody: unknown = { sent: 0, received: 0, peers: [], recent: [] };
let messageFetches: string[] = [];

function stubFetch(tree: AgentTreeNode[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/agents/tree")) {
        return Promise.resolve(
          new Response(JSON.stringify(tree), { status: 200 }),
        );
      }
      if (url.includes("/messages")) {
        messageFetches.push(url);
        return Promise.resolve(
          new Response(JSON.stringify(messagesBody), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
}

const fleet = [
  node("Lead", [node("Worker"), node("Helper", [node("Deep")])]),
  node("Other"),
];
const bubble = (id: string) =>
  document.querySelector(`[data-org-bubble="${id}"]`) as HTMLElement | null;
const card = (id: string) =>
  document.querySelector(`[data-org-card="${id}"]`) as HTMLElement | null;

async function mount(mode?: "animated" | "quiet" | "off") {
  if (mode) localStorage.setItem("autonomos.orgchart.messages", mode);
  stubFetch(fleet);
  useStore.setState({
    theme: "void",
    sessions: ["Lead", "Worker", "Helper", "Deep", "Other"].map(session),
    exitedSessions: [],
    agentStatuses: {},
    notificationCounts: {},
  });
  render(<HierarchyPanel />);
  await waitFor(() => expect(card("Other")).not.toBeNull());
}

beforeEach(() => {
  localStorage.clear();
  messagesBody = { sent: 0, received: 0, peers: [], recent: [] };
  messageFetches = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("message flow on the chart", () => {
  it("a message lands as a bubble on the recipient: sender + one-line preview", async () => {
    await mount("quiet");
    send(routed("Worker", "Lead", "PR #412 is ready for review"));
    const b = bubble("Lead") as HTMLElement;
    expect(b).not.toBeNull();
    expect(b).toHaveTextContent("Worker");
    expect(b).toHaveTextContent("PR #412 is ready for review");
  });

  it("a preview is TEXT, never markup", async () => {
    await mount("quiet");
    send(routed("Worker", "Lead", '<img src=x onerror="alert(1)">'));
    const b = bubble("Lead") as HTMLElement;
    expect(b.querySelector("img")).toBeNull();
    expect(b).toHaveTextContent('<img src=x onerror="alert(1)">');
  });

  it("a burst coalesces into ONE bubble with +N and the newest line", async () => {
    await mount("quiet");
    for (const t of ["one", "two", "three", "four", "five", "six"]) {
      send(routed("Worker", "Lead", t));
    }
    expect(document.querySelectorAll('[data-org-bubble="Lead"]').length).toBe(
      1,
    );
    expect(
      bubble("Lead")?.querySelector("[data-org-bubble-count]"),
    ).toHaveTextContent("+5");
    expect(
      bubble("Lead")?.querySelector("[data-org-bubble-text]"),
    ).toHaveTextContent("six");
  });

  it("Animated sends an envelope that travels, then lands", async () => {
    await mount("animated");
    send(routed("Worker", "Lead", "hello"));
    expect(document.querySelector("[data-org-envelope]")).not.toBeNull();
    expect(bubble("Lead")).toBeNull(); // still traveling
    await waitFor(() => expect(bubble("Lead")).not.toBeNull(), {
      timeout: 3000,
    });
    expect(document.querySelector("[data-org-envelope]")).toBeNull();
  });

  it("at most three envelopes fly at once; the rest land immediately", async () => {
    await mount("animated");
    send(routed("Worker", "Lead", "a"));
    send(routed("Helper", "Lead", "b"));
    send(routed("Other", "Worker", "c"));
    expect(document.querySelectorAll("[data-org-envelope]").length).toBe(3);
    send(routed("Lead", "Other", "d"));
    expect(document.querySelectorAll("[data-org-envelope]").length).toBe(3);
    expect(bubble("Other")).toHaveTextContent("d");
  });

  it("an envelope ALWAYS lands even if animation frames stop (background tab)", async () => {
    // Browsers pause rAF in hidden/occluded tabs; measured live, envelopes then
    // hung mid-edge forever. Freeze rAF entirely and require a landing anyway.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    await mount("animated");
    send(routed("Worker", "Lead", "while you were away"));
    expect(document.querySelector("[data-org-envelope]")).not.toBeNull();
    await waitFor(
      () => expect(bubble("Lead")).toHaveTextContent("while you were away"),
      {
        timeout: 3000,
      },
    );
    expect(document.querySelector("[data-org-envelope]")).toBeNull();
  });

  it("a hidden tab doesn't animate at all: messages land directly", async () => {
    await mount("animated");
    const vis = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    send(routed("Worker", "Lead", "quietly"));
    expect(document.querySelector("[data-org-envelope]")).toBeNull();
    expect(bubble("Lead")).toHaveTextContent("quietly");
    vis.mockRestore();
  });

  it("Off shows nothing; Quiet shows bubbles with no envelope", async () => {
    await mount("off");
    send(routed("Worker", "Lead", "hidden"));
    expect(bubble("Lead")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Quiet" }));
    expect(localStorage.getItem("autonomos.orgchart.messages")).toBe("quiet");
    send(routed("Worker", "Lead", "shown"));
    expect(bubble("Lead")).toHaveTextContent("shown");
    expect(document.querySelector("[data-org-envelope]")).toBeNull();
  });

  it("prefers-reduced-motion behaves like Quiet: no travel", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await mount("animated");
    send(routed("Worker", "Lead", "calm"));
    expect(document.querySelector("[data-org-envelope]")).toBeNull();
    expect(bubble("Lead")).toHaveTextContent("calm");
  });

  it("a message to an agent folded away lands on its nearest visible lead", async () => {
    await mount("quiet");
    fireEvent.click(
      document.querySelector('[data-org-collapse="Helper"]') as HTMLElement,
    );
    expect(card("Deep")).toBeNull();
    send(routed("Other", "Deep", "for the deep one"));
    expect(bubble("Helper")).toHaveTextContent("for the deep one");
  });

  it("a schedule sender (from=null) still lands, named", async () => {
    await mount("animated");
    send(routed(null, "Worker", "nightly triage"));
    expect(document.querySelector("[data-org-envelope]")).toBeNull();
    expect(bubble("Worker")).toHaveTextContent("Schedule nightly");
  });

  it("clicking a bubble selects the recipient (its inspector opens)", async () => {
    await mount("quiet");
    send(routed("Worker", "Lead", "hi"));
    fireEvent.click(bubble("Lead") as HTMLElement);
    expect(
      document.querySelector('[data-org-inspector="Lead"]'),
    ).not.toBeNull();
  });
});

describe("inspector: Communication (full text on demand)", () => {
  it("fetches the selected agent's log and renders peers + recent messages as text", async () => {
    messagesBody = {
      sent: 2,
      received: 3,
      peers: [{ id: "Worker", name: "Worker", sent: 1, received: 2 }],
      recent: [
        {
          id: "x1",
          from: "Worker",
          fromName: "Worker",
          to: "Lead",
          toName: "Lead",
          text: "<b>not bold</b> full text here",
          ts: Date.now(),
        },
      ],
    };
    await mount("quiet");
    fireEvent.click(card("Lead") as HTMLElement);
    const section = await waitFor(() => {
      const el = document.querySelector("[data-org-communication]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(
      messageFetches.some((u) => u.includes("/api/agents/Lead/messages")),
    ).toBe(true);
    expect(section).toHaveTextContent("Sent 2 · Received 3");
    expect(section).toHaveTextContent("← Worker");
    expect(section.querySelector("b")).toBeNull();
    expect(section).toHaveTextContent("<b>not bold</b> full text here");
    fireEvent.click(screen.getByRole("button", { name: "Worker 1↔2" }));
    expect(
      document.querySelector('[data-org-inspector="Worker"]'),
    ).not.toBeNull();
  });

  it("refetches when a message to the selected agent is routed", async () => {
    await mount("quiet");
    fireEvent.click(card("Lead") as HTMLElement);
    await waitFor(() => expect(messageFetches.length).toBe(1));
    send(routed("Worker", "Lead", "new"));
    await waitFor(() => expect(messageFetches.length).toBe(2), {
      timeout: 2000,
    });
    send(routed("Worker", "Other", "unrelated"));
    await new Promise((r) => setTimeout(r, 450));
    expect(messageFetches.length).toBe(2);
  });
});
