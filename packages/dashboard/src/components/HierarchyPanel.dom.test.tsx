// @vitest-environment jsdom
import type { AgentTreeNode } from "@autonomos/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { closeTopEscape, hasEscapeCloser } from "../shortcuts/escapeStack";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";
import { CARD_H, PAD, V_GAP } from "./orgchart/layout";
import {
  STATUS_COLORS_DARK,
  STATUS_COLORS_LIGHT,
  UNREAD_COLOR_LIGHT,
} from "./statusLabelStyle";

/**
 * HierarchyPanel — the org chart. It reads the exited-inclusive tree
 * (`/api/agents/tree?includeExited=true`) and renders loading / error / empty /
 * a canvas of cards. Each block below pins one audit finding (F1–F9) so a
 * regression names the problem it reintroduces.
 */

let lastTreeUrl = "";

/** Real `Response` objects: the api client reads the body via `res.text()`. */
function stubTreeFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.includes("/api/agents/tree")) {
        lastTreeUrl = url;
        return impl();
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
}

function tree(nodes: unknown[]) {
  stubTreeFetch(() =>
    Promise.resolve(new Response(JSON.stringify(nodes), { status: 200 })),
  );
}

function node(
  id: string,
  status: "running" | "exited",
  children: AgentTreeNode[] = [],
  extra: Partial<AgentTreeNode> = {},
): AgentTreeNode {
  return {
    id,
    claudeSessionId: id,
    name: id,
    status,
    provider: "claude-code",
    children,
    ...extra,
  } as AgentTreeNode;
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    workingDirectory: `/work/${id}`,
    createdAt: Date.now() - 5 * 60_000,
    updatedAt: Date.now(),
    provider: "claude-code",
    ...extra,
  } as never;
}

const card = (id: string) =>
  document.querySelector(`[data-org-card="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  lastTreeUrl = "";
  localStorage.clear();
  useStore.setState({
    theme: "void",
    sessions: [],
    exitedSessions: [],
    agentStatuses: {},
    notificationCounts: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HierarchyPanel — content states", () => {
  it("shows the empty-state guidance when no agents are running", async () => {
    tree([]);
    render(<HierarchyPanel />);
    expect(await screen.findByText(/no agents running/i)).toBeInTheDocument();
    expect(
      screen.getByText(/managers and their reports appear here/i),
    ).toHaveTextContent(
      "Create an agent, then ask it to spawn helpers — managers and their reports appear here",
    );
  });

  it("shows an error state with retry copy when the server returns non-ok", async () => {
    stubTreeFetch(() => Promise.resolve(new Response(null, { status: 500 })));
    render(<HierarchyPanel />);
    expect(
      await screen.findByText(/server error \(500\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/retrying automatically/i)).toBeInTheDocument();
  });

  it("shows 'Cannot reach server' when the fetch rejects", async () => {
    stubTreeFetch(() => Promise.reject(new Error("network down")));
    render(<HierarchyPanel />);
    expect(await screen.findByText(/cannot reach server/i)).toBeInTheDocument();
  });

  it("renders a card with name and live status; the template rides the tooltip", async () => {
    tree([node("Dispatcher", "running", [], { template: "dispatcher" })]);
    useStore.setState({
      sessions: [session("Dispatcher")],
      agentStatuses: { Dispatcher: { status: "working" } as never },
    });
    render(<HierarchyPanel />);
    expect(await screen.findByText("Dispatcher")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(card("Dispatcher")?.title).toBe("Dispatcher · dispatcher");
  });
});

describe("F3 + F6 — an exited manager keeps its team and can be resumed", () => {
  it("asks for the exited-inclusive tree", async () => {
    tree([node("A", "running")]);
    render(<HierarchyPanel />);
    await screen.findByText("A");
    expect(lastTreeUrl).toContain("includeExited=true");
  });

  it("draws the exited lead as a ghost with its running report still under it", async () => {
    tree([
      node("Dispatcher", "running", [
        node("BackendLead", "exited", [node("APIWorker", "running")]),
      ]),
    ]);
    const resumeSession = vi.fn(() => Promise.resolve());
    useStore.setState({
      sessions: [session("Dispatcher"), session("APIWorker")],
      exitedSessions: [session("BackendLead", { status: "exited" })],
      resumeSession: resumeSession as never,
    });
    render(<HierarchyPanel />);
    await screen.findByText("APIWorker");

    const lead = card("BackendLead");
    const worker = card("APIWorker");
    expect(lead?.dataset.orgStatus).toBe("exited");
    expect(lead?.style.borderStyle || lead?.style.border).toContain("dashed");
    // The report sits one level BELOW the ghost, not promoted to the top row.
    expect(Number.parseFloat(worker?.style.top ?? "0")).toBe(
      PAD + 2 * (CARD_H + V_GAP),
    );
    expect(
      document.querySelector('[data-org-edge="BackendLead>APIWorker"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(resumeSession).toHaveBeenCalledWith(
      "BackendLead",
      "/work/BackendLead",
      "BackendLead",
      { isAutonomosAgent: true },
    );
  });

  it("hides exited agents that hold no live team behind a 'Show N exited' toggle", async () => {
    tree([
      node("Lead", "running", [node("Gone", "exited")]),
      node("OldSolo", "exited"),
    ]);
    render(<HierarchyPanel />);
    await screen.findByText("Lead");
    expect(card("Gone")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show 2 exited" });
    fireEvent.click(toggle);
    expect(card("Gone")).not.toBeNull();
    expect(card("OldSolo")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Hide exited" }),
    ).toBeInTheDocument();
  });
});

describe("F7 — teams side by side, solo agents on a shelf", () => {
  it("puts two team leads on the same row and a solo agent on the Unassigned shelf", async () => {
    tree([
      node("TeamA", "running", [node("a1", "running")]),
      node("TeamB", "running", [node("b1", "running")]),
      node("Solo", "running"),
    ]);
    render(<HierarchyPanel />);
    await screen.findByText("Solo");
    expect(card("TeamA")?.style.top).toBe(card("TeamB")?.style.top);
    expect(card("TeamA")?.style.left).not.toBe(card("TeamB")?.style.left);
    expect(screen.getByText("Unassigned · 1")).toBeInTheDocument();
    expect(Number.parseFloat(card("Solo")?.style.top ?? "0")).toBeGreaterThan(
      Number.parseFloat(card("a1")?.style.top ?? "0"),
    );
  });
});

describe("F1 + F8 — status colors are the sidebar's", () => {
  it("a needs-input card uses the sidebar's amber, pulses, and is listed in 'needs you'", async () => {
    tree([node("Waiting", "running"), node("Idle", "running")]);
    useStore.setState({
      sessions: [session("Waiting"), session("Idle")],
      agentStatuses: {
        Waiting: { status: "needs_input", currentTool: "Bash" } as never,
        Idle: { status: "idle" } as never,
      },
    });
    render(<HierarchyPanel />);
    // The name shows twice (card + "needs you" pill) — wait on the card.
    await waitFor(() => expect(card("Waiting")).not.toBeNull());

    const w = card("Waiting");
    expect(w?.dataset.orgStatus).toBe("needs_input");
    expect(w?.className).toContain("org-card-attention");
    expect(w?.style.border).toContain(hexToRgb(STATUS_COLORS_DARK.needsInput));
    expect(card("Idle")?.className).not.toContain("org-card-attention");
    expect(card("Idle")?.style.border).not.toContain(
      hexToRgb(STATUS_COLORS_DARK.needsInput),
    );

    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(
      document.querySelector('[data-org-waiting="Waiting"]'),
    ).toHaveTextContent("WaitingBash");
  });

  it("a working card breathes and its label uses the sidebar's shimmer class", async () => {
    tree([node("Busy", "running")]);
    useStore.setState({
      sessions: [session("Busy")],
      agentStatuses: {
        Busy: { status: "tool_running", currentTool: "Bash" } as never,
      },
    });
    render(<HierarchyPanel />);
    await screen.findByText("Running Bash");
    expect(card("Busy")?.className).toContain("org-card-working");
    expect(screen.getByText("Running Bash").className).toContain(
      "status-shimmer",
    );
  });
});

describe("F2 — Daylight draws from tokens", () => {
  it("light cards, dark connectors, light-palette amber; none of the old hardcoded dark", async () => {
    tree([node("Lead", "running", [node("Rep", "running")])]);
    useStore.setState({
      theme: "daylight",
      sessions: [session("Lead"), session("Rep")],
      agentStatuses: { Rep: { status: "needs_input" } as never },
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Rep")).not.toBeNull());
    expect(card("Lead")?.style.background).toBe("rgb(255, 255, 255)");
    expect(card("Rep")?.style.border).toContain(
      hexToRgb(STATUS_COLORS_LIGHT.needsInput),
    );
    const edge = document.querySelector('[data-org-edge="Lead>Rep"]');
    expect(edge?.getAttribute("stroke")).toBe("rgba(0,0,0,0.2)");
    expect(document.body.innerHTML).not.toContain("28, 36, 51");
    expect(screen.getByText("Needs input").className).not.toContain(
      "status-shimmer",
    );
  });
});

describe('Daylight contrast (Terry: "the words look so faint")', () => {
  it("uses the darker unread red and lighter-handed muting on light themes", async () => {
    tree([
      node("Lead", "exited", [node("Kid", "running")]),
      node("X", "running"),
    ]);
    useStore.setState({
      theme: "daylight",
      sessions: [session("Kid"), session("X")],
      notificationCounts: { Kid: 2 },
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Kid")).not.toBeNull());
    expect(screen.getByText("2 unread").style.color).toBe(
      hexToRgb(UNREAD_COLOR_LIGHT),
    );
    const ghostName = card("Lead")?.querySelector(".truncate") as HTMLElement;
    expect(Number(ghostName.style.opacity)).toBeGreaterThan(0.6);
    fireEvent.click(card("Kid") as HTMLElement);
    expect(Number(card("X")?.style.opacity)).toBeGreaterThan(0.45);
  });
});

describe("F4 + F5 — click SELECTS (Terry's pick), explicit open, right-click menu", () => {
  it("click selects without leaving the chart; double-click opens and clears unread", async () => {
    tree([node("A", "running")]);
    const switchPane = vi.fn();
    const markNotificationsRead = vi.fn(() => Promise.resolve());
    useStore.setState({
      sessions: [session("A")],
      notificationCounts: { A: 3 },
      switchPane,
      markNotificationsRead: markNotificationsRead as never,
    });
    render(<HierarchyPanel />);
    await screen.findByText("A");
    expect(screen.getByText("3 unread")).toBeInTheDocument(); // F9 parity
    fireEvent.click(card("A") as HTMLElement);
    expect(switchPane).not.toHaveBeenCalled();
    expect(card("A")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[data-org-inspector="A"]')).not.toBeNull();
    fireEvent.doubleClick(card("A") as HTMLElement);
    expect(switchPane).toHaveBeenCalledWith({ type: "session", id: "A" });
    expect(markNotificationsRead).toHaveBeenCalledWith("A");
  });

  it("Enter opens a running card; an exited ghost selects (it has no terminal)", async () => {
    tree([node("Lead", "exited", [node("Kid", "running")])]);
    const switchPane = vi.fn();
    useStore.setState({ sessions: [session("Kid")], switchPane });
    render(<HierarchyPanel />);
    await screen.findByText("Kid");
    expect(card("Kid")?.tagName).toBe("BUTTON");
    fireEvent.keyDown(card("Kid") as HTMLElement, { key: "Enter" });
    expect(switchPane).toHaveBeenCalledTimes(1);
    fireEvent.click(card("Lead") as HTMLElement);
    fireEvent.doubleClick(card("Lead") as HTMLElement);
    expect(switchPane).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector(
        '[data-org-inspector="Lead"] [data-org-action="resume"]',
      ),
    ).not.toBeNull();
  });

  it("right-click opens the shared agent menu for that agent; no trash overlay exists", async () => {
    tree([node("Mgr", "running", [node("Rep", "running")])]);
    useStore.setState({ sessions: [session("Mgr"), session("Rep")] });
    render(<HierarchyPanel />);
    await screen.findByText("Rep");
    expect(
      document.querySelector('[title="Kill and remove agent"]'),
    ).toBeNull();

    fireEvent.contextMenu(card("Rep") as HTMLElement, {
      clientX: 40,
      clientY: 50,
    });
    const items = await screen.findAllByRole("menuitem");
    // Portaled OUT of the panel: inside a dockview pane, `.dv-render-overlay`
    // (transform + contain) re-anchors position:fixed to the pane.
    const panel = document.querySelector("[data-org-chart]");
    expect(panel?.contains(items[0])).toBe(false);
    const labels = items.map((i) => i.textContent ?? "");
    for (const want of ["Open", "Rename…", "Restart", "Kill", "Delete…"]) {
      expect(labels.some((l) => l.includes(want))).toBe(true);
    }
  });

  it("an exited card's menu offers Resume", async () => {
    tree([node("Ghost", "exited", [node("Live", "running")])]);
    useStore.setState({
      sessions: [session("Live")],
      exitedSessions: [session("Ghost", { status: "exited" })],
    });
    render(<HierarchyPanel />);
    await screen.findByText("Live");
    fireEvent.contextMenu(card("Ghost") as HTMLElement);
    const items = await screen.findAllByRole("menuitem");
    expect(items.some((i) => i.textContent?.includes("Resume"))).toBe(true);
    expect(items.some((i) => i.textContent?.includes("Kill"))).toBe(false);
  });
});

describe("selection + inspector", () => {
  const fleet = () => {
    tree([
      node("Mgr", "running", [node("R1", "running"), node("R2", "running")]),
      node("Other", "running", [node("O1", "running")]),
    ]);
    useStore.setState({
      sessions: ["Mgr", "R1", "R2", "Other", "O1"].map((id) =>
        session(
          id,
          id === "R1" ? { template: "worker", envPreset: "kimi" } : {},
        ),
      ),
      agentStatuses: { R1: { status: "needs_input" } as never },
    });
  };
  const inspector = () =>
    document.querySelector("[data-org-inspector]") as HTMLElement | null;

  it("selecting lights the chain and dims everyone else", async () => {
    fleet();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.click(card("R1") as HTMLElement);
    expect(card("R1")?.style.outline).toContain("solid");
    expect(card("Mgr")?.style.opacity).toBe(""); // manager chain: lit
    expect(card("Other")?.style.opacity).toBe("0.45"); // outside: dimmed
    expect(card("R2")?.style.opacity).toBe("0.45"); // a sibling isn't chain
  });

  it("the inspector shows status, config and team, and its chips move the selection", async () => {
    fleet();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.click(card("R1") as HTMLElement);
    const insp = inspector() as HTMLElement;
    expect(insp.dataset.orgInspector).toBe("R1");
    expect(insp).toHaveTextContent("Needs input");
    expect(insp).toHaveTextContent("Claude Code");
    expect(insp).toHaveTextContent("kimi");
    expect(insp).toHaveTextContent("worker");
    fireEvent.click(screen.getByRole("button", { name: "Mgr" }));
    expect(inspector()?.dataset.orgInspector).toBe("Mgr");
    fireEvent.click(screen.getByRole("button", { name: "R2" }));
    expect(inspector()?.dataset.orgInspector).toBe("R2");
  });

  it("Open terminal in the inspector opens; × and Esc (escape stack) close it", async () => {
    fleet();
    const switchPane = vi.fn();
    useStore.setState({ switchPane });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.click(card("R2") as HTMLElement);
    fireEvent.click(
      document.querySelector('[data-org-action="open"]') as HTMLElement,
    );
    expect(switchPane).toHaveBeenCalledWith({ type: "session", id: "R2" });
    // Opening leaves the chart, so the selection (and its inspector) drops.
    expect(inspector()).toBeNull();

    fireEvent.click(card("R2") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(inspector()).toBeNull();

    // A real click: pointer-down lands IN the chart, so Esc is ours.
    fireEvent.pointerDown(card("R2") as HTMLElement);
    fireEvent.click(card("R2") as HTMLElement);
    expect(hasEscapeCloser()).toBe(true);
    act(() => closeTopEscape());
    expect(inspector()).toBeNull();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("opening an agent from the chart drops the selection — Esc is NOT held for a hidden chart (nox, #390)", async () => {
    // Dockview keeps this panel mounted while hidden; a lingering selection
    // used to keep an escape closer, so the first Esc typed into the terminal
    // you just opened only cleared the invisible selection.
    fleet();
    const switchPane = vi.fn();
    useStore.setState({ switchPane });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.pointerDown(card("R2") as HTMLElement);
    fireEvent.click(card("R2") as HTMLElement);
    expect(hasEscapeCloser()).toBe(true);
    fireEvent.doubleClick(card("R2") as HTMLElement);
    expect(switchPane).toHaveBeenCalled();
    expect(inspector()).toBeNull();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("focus or a pointer landing OUTSIDE the chart releases Escape but keeps the selection", async () => {
    fleet();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.pointerDown(card("R1") as HTMLElement);
    fireEvent.click(card("R1") as HTMLElement);
    expect(hasEscapeCloser()).toBe(true);
    // e.g. clicking into a terminal pane beside the chart in a split layout
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.focusIn(outside);
    expect(hasEscapeCloser()).toBe(false);
    expect(inspector()?.dataset.orgInspector).toBe("R1");
    // Coming back into the chart re-arms it.
    fireEvent.pointerDown(card("R1") as HTMLElement);
    expect(hasEscapeCloser()).toBe(true);
    outside.remove();
  });

  it("the inspector STICKS: clicks on empty canvas don't close it (Terry)", async () => {
    fleet();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.click(card("R1") as HTMLElement);
    fireEvent.click(document.querySelector("[data-org-stage]") as HTMLElement);
    fireEvent.click(
      document.querySelector("[data-org-viewport]") as HTMLElement,
    );
    expect(inspector()?.dataset.orgInspector).toBe("R1");
    // Another card switches it; the × closes it.
    fireEvent.click(card("O1") as HTMLElement);
    expect(inspector()?.dataset.orgInspector).toBe("O1");
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(inspector()).toBeNull();
  });

  it("leaving the pane (dockview hides it) closes the inspector", async () => {
    fleet();
    const { rerender } = render(<HierarchyPanel visible />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.click(card("R1") as HTMLElement);
    expect(hasEscapeCloser()).toBe(true);
    rerender(<HierarchyPanel visible={false} />);
    expect(inspector()).toBeNull();
    // Nothing on the hidden chart keeps Escape reserved.
    expect(hasEscapeCloser()).toBe(false);
    // Coming back shows the chart with nothing selected.
    rerender(<HierarchyPanel visible />);
    expect(inspector()).toBeNull();
  });

  it("arrow keys walk the chart: ↑ manager, ↓ first report, → sibling", async () => {
    fleet();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("O1")).not.toBeNull());
    fireEvent.click(card("Mgr") as HTMLElement);
    fireEvent.keyDown(card("Mgr") as HTMLElement, { key: "ArrowDown" });
    expect(inspector()?.dataset.orgInspector).toBe("R1");
    fireEvent.keyDown(card("R1") as HTMLElement, { key: "ArrowRight" });
    expect(inspector()?.dataset.orgInspector).toBe("R2");
    fireEvent.keyDown(card("R2") as HTMLElement, { key: "ArrowUp" });
    expect(inspector()?.dataset.orgInspector).toBe("Mgr");
    fireEvent.keyDown(card("Mgr") as HTMLElement, { key: "ArrowRight" });
    expect(inspector()?.dataset.orgInspector).toBe("Other");
  });
});

describe("PR 2 — team rollups + collapse", () => {
  const fleet = () =>
    tree([
      node("Lead", "running", [
        node("Sub", "running", [node("Deep", "running")]),
        node("Busy", "running"),
        node("Gone", "exited"),
      ]),
      node("Solo", "running"),
    ]);
  const statuses = () =>
    useStore.setState({
      sessions: ["Lead", "Sub", "Deep", "Busy", "Solo"].map((id) =>
        session(id),
      ),
      agentStatuses: {
        Deep: { status: "needs_input" } as never,
        Busy: { status: "working" } as never,
        Sub: { status: "idle" } as never,
      },
    });
  const rollup = (id: string) =>
    document.querySelector(`[data-org-rollup="${id}"]`)?.textContent ?? null;
  const toggle = (id: string) =>
    document.querySelector(`[data-org-collapse="${id}"]`) as HTMLElement | null;

  it("a lead's card summarizes its WHOLE team; leaves and solo agents get none", async () => {
    fleet();
    statuses();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Deep")).not.toBeNull());
    // Deep (needs you) is two levels down; Gone is exited and HIDDEN, so it
    // doesn't count (a reaping manager must not read "N exited" forever).
    expect(rollup("Lead")).toBe("1 needs you1 working1 idle");
    expect(rollup("Sub")).toBe("1 needs you");
    expect(rollup("Busy")).toBeNull();
    expect(rollup("Solo")).toBeNull();
  });

  it("the needs-you chip is the sidebar's amber", async () => {
    fleet();
    statuses();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Deep")).not.toBeNull());
    // Scope to the rollup: the toolbar strip ALSO reads "1 needs you".
    const chip = document.querySelector(
      '[data-org-rollup="Lead"] span',
    ) as HTMLElement;
    expect(chip.textContent).toBe("1 needs you");
    expect(chip.style.color).toBe(hexToRgb(STATUS_COLORS_DARK.needsInput));
  });

  it("collapsing folds the team into a +N stack, keeps the rollup, and stays in the team row", async () => {
    fleet();
    statuses();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Deep")).not.toBeNull());
    const top = card("Lead")?.style.top;

    const t = toggle("Lead") as HTMLElement;
    expect(t.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(t);

    expect(card("Sub")).toBeNull();
    expect(card("Deep")).toBeNull();
    expect(card("Lead")?.style.top).toBe(top); // not dropped onto the shelf
    expect(toggle("Lead")?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle("Lead")?.textContent).toBe("+3");
    expect(rollup("Lead")).toBe("1 needs you1 working1 idle");
    expect(
      document.querySelectorAll('[data-org-stack="Lead"]').length,
    ).toBeGreaterThan(0);
    // Still reachable: the needs-you strip lists the hidden agent.
    expect(document.querySelector('[data-org-waiting="Deep"]')).not.toBeNull();

    fireEvent.click(toggle("Lead") as HTMLElement);
    expect(card("Deep")).not.toBeNull();
  });

  it("a lead with every bucket shows at most 3 chips (priority order) + a +N chip", async () => {
    tree([
      node("Big", "running", [
        node("n1", "running"),
        node("e1", "running"),
        node("w1", "running"),
        node("i1", "running"),
        node("x1", "exited", [node("keep", "running")]),
      ]),
    ]);
    useStore.setState({
      sessions: ["Big", "n1", "e1", "w1", "i1", "keep"].map((id) =>
        session(id),
      ),
      agentStatuses: {
        n1: { status: "needs_input" } as never,
        e1: { status: "error" } as never,
        w1: { status: "working" } as never,
        i1: { status: "idle" } as never,
        keep: { status: "idle" } as never,
      },
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("keep")).not.toBeNull());
    const r = document.querySelector('[data-org-rollup="Big"]') as HTMLElement;
    const chips = [...r.querySelectorAll("span")].map((c) => c.textContent);
    // Exactly three status chips, then the "+N" overflow chip — never five.
    expect(chips).toEqual(["1 needs you", "1 error", "1 working", "+2"]);
    const more = r.querySelector("[data-org-rollup-more]") as HTMLElement;
    expect(more.textContent).toBe("+2");
    expect(more.title).toBe("2 idle · 1 exited");
  });

  it("folding the team of a SELECTED agent keeps its lead lit, not dimmed (nox, #391)", async () => {
    fleet();
    statuses();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Deep")).not.toBeNull());
    fireEvent.click(card("Deep") as HTMLElement);
    fireEvent.click(toggle("Sub") as HTMLElement);
    expect(card("Deep")).toBeNull();
    // Sub (the folded lead) and Lead are Deep's chain: lit. Busy is not: dim.
    expect(card("Sub")?.style.opacity).toBe("");
    expect(card("Lead")?.style.opacity).toBe("");
    expect(card("Busy")?.style.opacity).not.toBe("");
    expect(
      document.querySelector('[data-org-inspector="Deep"]'),
    ).not.toBeNull();
  });

  it("remembers folded teams across mounts (per browser)", async () => {
    fleet();
    statuses();
    const first = render(<HierarchyPanel />);
    await waitFor(() => expect(card("Deep")).not.toBeNull());
    fireEvent.click(toggle("Sub") as HTMLElement);
    expect(card("Deep")).toBeNull();
    first.unmount();

    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Sub")).not.toBeNull());
    expect(card("Deep")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("autonomos.orgchart.collapsed") ?? "[]"),
    ).toEqual(["Sub"]);
  });

  it("a corrupt persisted value is ignored, not fatal", async () => {
    localStorage.setItem("autonomos.orgchart.collapsed", "{not json");
    fleet();
    statuses();
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Deep")).not.toBeNull());
  });
});

describe("keyboard + assistive tech", () => {
  it("focus shows as an OUTLINE (box-shadow belongs to the status animations)", async () => {
    tree([node("A", "running")]);
    render(<HierarchyPanel />);
    await screen.findByText("A");
    const cls = card("A")?.className ?? "";
    expect(cls).toContain("focus-visible:outline-2");
    expect(cls).not.toContain("ring-");
    expect(cls).not.toContain("outline-none");
    // Themed focus color (the app's slate, not the browser's default blue).
    expect(card("A")?.style.outlineColor).toBe(
      hexToRgb(STATUS_COLORS_DARK.active),
    );
  });

  it("a ghost is a labelled group so its Resume button stays reachable; running cards are buttons with unread in the label", async () => {
    tree([node("Ghost", "exited", [node("Live", "running")])]);
    useStore.setState({
      sessions: [session("Live")],
      notificationCounts: { Live: 2 },
    });
    render(<HierarchyPanel />);
    await screen.findByText("Live");
    expect(card("Ghost")?.tagName).toBe("FIELDSET"); // native group
    expect(
      screen.getByRole("group", { name: /Ghost, Exited/ }),
    ).toContainElement(screen.getByRole("button", { name: "Resume" }));
    expect(card("Live")?.tagName).toBe("BUTTON");
    expect(card("Live")?.getAttribute("aria-label")).toContain("2 unread");
  });

  it("the Menu key's trailing native contextmenu doesn't move the menu it just opened", async () => {
    tree([node("A", "running")]);
    useStore.setState({ sessions: [session("A")] });
    render(<HierarchyPanel />);
    await screen.findByText("A");
    const el = card("A") as HTMLElement;
    fireEvent.keyDown(el, { key: "F10", shiftKey: true });
    const menu = () =>
      (screen
        .getAllByRole("menuitem")[0]
        .closest("[style*='position: fixed']") ??
        screen.getAllByRole("menuitem")[0].parentElement) as HTMLElement;
    const before = menu().getAttribute("style");
    // What Windows/Linux Chrome sends on the Menu key's keyup.
    fireEvent.contextMenu(el, { clientX: 400, clientY: 300 });
    expect(menu().getAttribute("style")).toBe(before);
  });
});

describe("F9 — recency parity with the sidebar", () => {
  it("a stale IDLE label fades like the sidebar's (#383); a stale waiting one never does", async () => {
    const twoDays = Date.now() - 2 * 86_400_000;
    tree([node("Sleepy", "running"), node("Stuck", "running")]);
    useStore.setState({
      sessions: [
        session("Sleepy", { lastActivityAt: twoDays }),
        session("Stuck", { lastActivityAt: twoDays }),
      ],
      agentStatuses: {
        Sleepy: { status: "idle" } as never,
        Stuck: { status: "needs_input" } as never,
      },
    });
    render(<HierarchyPanel />);
    await waitFor(() => expect(card("Stuck")).not.toBeNull());
    const label = (id: string) =>
      card(id)?.querySelector("[data-org-label]") as HTMLElement;
    expect(label("Sleepy").textContent).toBe("Idle");
    expect(Number(label("Sleepy").style.opacity)).toBeLessThan(1);
    expect(label("Stuck").style.opacity).toBe("1");
  });

  it("shows the same compact age the sidebar would", async () => {
    tree([node("Old", "running")]);
    useStore.setState({
      sessions: [
        session("Old", { lastActivityAt: Date.now() - 3 * 3_600_000 }),
      ],
    });
    render(<HierarchyPanel />);
    await screen.findByText("Old");
    await waitFor(() => expect(card("Old")).toHaveTextContent("3h"));
  });
});

/** jsdom normalizes `#rrggbb` inside `border` to `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const v = hex.replace("#", "");
  const r = Number.parseInt(v.slice(0, 2), 16);
  const g = Number.parseInt(v.slice(2, 4), 16);
  const b = Number.parseInt(v.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
