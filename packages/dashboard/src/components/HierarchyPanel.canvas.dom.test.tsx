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
import { orgTreePoll } from "../api/polls";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";

/**
 * PR 5 canvas: pan / zoom / fit / map, with Terry's picks — scroll pans and
 * pinch / ⌘ zooms (1A), the map shows only when the chart doesn't fit (2A),
 * bubbles counter-scale (3A), and the opening view fits with a 60% floor (4A).
 */

// jsdom has no layout: give the canvas viewport a real size.
let VP = { w: 900, h: 500 };
const proto = HTMLElement.prototype;
const origW = Object.getOwnPropertyDescriptor(proto, "clientWidth");
const origH = Object.getOwnPropertyDescriptor(proto, "clientHeight");
beforeEach(() => {
  VP = { w: 900, h: 500 };
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-org-viewport") ? VP.w : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-org-viewport") ? VP.h : 0;
    },
  });
  // Glides animate; reduced motion makes every view change land at once.
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("reduce"),
        media: q,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      }) as unknown as MediaQueryList,
  );
  localStorage.clear();
});
afterEach(() => {
  if (origW) Object.defineProperty(proto, "clientWidth", origW);
  if (origH) Object.defineProperty(proto, "clientHeight", origH);
  vi.unstubAllGlobals();
});

function stubTree(nodes: AgentTreeNode[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          url.includes("/api/agents/tree") ? JSON.stringify(nodes) : "{}",
          { status: 200 },
        ),
      ),
    ),
  );
}
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

/** A lead with `n` reports: wide enough not to fit at the 60% floor. */
function bigFleet(n = 16) {
  const ids = Array.from({ length: n }, (_, i) => `W${i}`);
  stubTree([
    node(
      "Lead",
      ids.map((i) => node(i)),
    ),
  ]);
  useStore.setState({
    theme: "void",
    sessions: ["Lead", ...ids].map(session),
    exitedSessions: [],
    agentStatuses: {},
    notificationCounts: {},
  });
}
function smallFleet() {
  stubTree([node("Lead", [node("A"), node("B")])]);
  useStore.setState({
    theme: "void",
    sessions: ["Lead", "A", "B"].map(session),
    exitedSessions: [],
    agentStatuses: {},
    notificationCounts: {},
  });
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const viewport = () => $("[data-org-viewport]") as HTMLElement;
const stage = () => $("[data-org-stage]") as HTMLElement;
const card = (id: string) => $(`[data-org-card="${id}"]`);
const pct = () => $("[data-org-zoom-pct]")?.textContent;
const view = () => {
  const m = stage().style.transform.match(
    /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/,
  );
  if (!m) throw new Error(`no view transform: "${stage().style.transform}"`);
  return { x: +m[1], y: +m[2], k: +m[3] };
};

/** jsdom drops pointer coordinates from synthesized events: set them as own props. */
function ptr(
  el: Element,
  type: string,
  {
    x,
    y,
    id = 1,
    button = 0,
  }: { x: number; y: number; id?: number; button?: number },
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: id },
    button: { value: button },
  });
  act(() => {
    el.dispatchEvent(e);
  });
}
function drag(
  from: Element,
  dx: number,
  dy: number,
  start = { x: 300, y: 300 },
) {
  ptr(from, "pointerdown", start);
  ptr(viewport(), "pointermove", { x: start.x + dx / 2, y: start.y + dy / 2 });
  ptr(viewport(), "pointermove", { x: start.x + dx, y: start.y + dy });
  ptr(viewport(), "pointerup", { x: start.x + dx, y: start.y + dy });
}

async function mount(fleet: () => void) {
  fleet();
  // The tree poll is a module-level cache: without a refresh, the FIRST render
  // would show the previous test's fleet, and the opening view (computed once,
  // on the first real size) would be computed for the wrong chart.
  await act(async () => {
    await orgTreePoll.refresh();
  });
  render(<HierarchyPanel />);
  await waitFor(() => expect(card("Lead")).not.toBeNull());
  await waitFor(() => expect(stage().style.transform).toContain("scale"));
}

describe("opening view (pick 4A: fit, never below 60%)", () => {
  it("a chart that fits opens fitted at 100% and the map stays hidden (2A)", async () => {
    await mount(smallFleet);
    expect(view().k).toBe(1);
    expect(pct()).toBe("100%");
    expect($("[data-org-minimap]")).toBeNull();
  });

  it("a chart too big for the floor opens AT 60%, top of the tree, and the map shows", async () => {
    await mount(bigFleet);
    expect(view().k).toBeCloseTo(0.6, 6);
    expect(pct()).toBe("60%");
    expect($("[data-org-minimap]")).not.toBeNull();
    expect(document.querySelectorAll("[data-org-minimap-card]").length).toBe(
      17,
    );
  });
});

describe("pan (drag EMPTY canvas)", () => {
  it("dragging empty canvas pans; the selection and inspector stay (the #425 rule)", async () => {
    await mount(bigFleet);
    fireEvent.click(card("W0") as HTMLElement);
    expect($("[data-org-inspector]")).not.toBeNull();
    const before = view();
    drag(stage(), -120, 40);
    const after = view();
    expect(after.x).toBeCloseTo(before.x - 120, 6);
    expect(after.y).toBeCloseTo(before.y + 40, 6);
    expect($("[data-org-inspector]")?.dataset.orgInspector).toBe("W0");
  });

  it("a press that moves under 4 px is a click: the view doesn't move", async () => {
    await mount(bigFleet);
    const before = view();
    drag(stage(), 2, 2);
    expect(view()).toEqual(before);
  });

  it("a drag that starts ON a card doesn't pan (reserved for PR 4's reassign)", async () => {
    await mount(bigFleet);
    const before = view();
    drag(card("W0") as HTMLElement, -150, 0);
    expect(view()).toEqual(before);
  });

  it("a scroll-pan or zoom closes an open context menu so it never floats off its card", async () => {
    // A drag already closes it (the menu's own outside-pointerdown); a wheel
    // sends no pointerdown, so the canvas must close it itself.
    await mount(bigFleet);
    fireEvent.contextMenu(card("W0") as HTMLElement, {
      clientX: 10,
      clientY: 10,
    });
    expect(screen.queryByRole("menu")).not.toBeNull();
    act(() => {
      fireEvent.wheel(viewport(), { deltaX: 0, deltaY: 40 });
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("zoom (pick 1A: scroll pans, pinch / ⌘ zooms)", () => {
  it("two-finger scroll pans", async () => {
    await mount(bigFleet);
    const before = view();
    act(() => {
      fireEvent.wheel(viewport(), { deltaX: 30, deltaY: 50 });
    });
    const after = view();
    expect(after.k).toBe(before.k);
    expect(after.x).toBeCloseTo(before.x - 30, 6);
    expect(after.y).toBeCloseTo(before.y - 50, 6);
  });

  it("a pinch (ctrl + wheel) zooms; so does ⌘ + scroll", async () => {
    await mount(bigFleet);
    const k0 = view().k;
    act(() => {
      fireEvent.wheel(viewport(), { deltaY: -40, ctrlKey: true });
    });
    const k1 = view().k;
    expect(k1).toBeGreaterThan(k0);
    act(() => {
      fireEvent.wheel(viewport(), { deltaY: 80, metaKey: true });
    });
    expect(view().k).toBeLessThan(k1);
  });

  it("buttons: + zooms in, the % resets to 100, Fit shows everyone and the map hides", async () => {
    // 8 reports: too wide for the 60% floor, but Fit can show them all.
    await mount(() => bigFleet(8));
    expect(pct()).toBe("60%");
    expect($("[data-org-minimap]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(pct()).toBe("75%");
    fireEvent.click($("[data-org-zoom-pct]") as HTMLElement);
    expect(pct()).toBe("100%");
    fireEvent.click($("[data-org-zoom-fit]") as HTMLElement);
    expect(view().k).toBeLessThan(0.6);
    expect(view().k).toBeGreaterThan(0.3);
    // Everything fits now, so the map has nothing to show (pick 2A).
    expect($("[data-org-minimap]")).toBeNull();
  });

  it("a fleet too wide even at 30%: Fit bottoms out at 30% and the map stays", async () => {
    await mount(() => bigFleet(16));
    fireEvent.click($("[data-org-zoom-fit]") as HTMLElement);
    expect(pct()).toBe("30%");
    expect($("[data-org-minimap]")).not.toBeNull();
  });

  it("keys while the chart has focus: F fits, 0 = 100%, + / − zoom", async () => {
    await mount(bigFleet);
    fireEvent.keyDown(viewport(), { key: "0" });
    expect(pct()).toBe("100%");
    fireEvent.keyDown(viewport(), { key: "-" });
    expect(pct()).toBe("80%");
    fireEvent.keyDown(viewport(), { key: "f" });
    expect(view().k).toBeLessThan(0.6);
    // Modified keys belong to someone else (browser / app shortcuts).
    const k = view().k;
    fireEvent.keyDown(viewport(), { key: "0", metaKey: true });
    expect(view().k).toBe(k);
  });

  it("bubbles counter-scale: the stage publishes 1/k (pick 3A)", async () => {
    await mount(bigFleet);
    expect(Number(stage().style.getPropertyValue("--org-inv-k"))).toBeCloseTo(
      1 / 0.6,
      6,
    );
  });
});

describe("the map and following the selection", () => {
  it("clicking the map moves the view there", async () => {
    await mount(bigFleet);
    const before = view();
    const svg = $("[data-org-minimap] svg") as HTMLElement;
    ptr(svg, "pointerdown", { x: 170, y: 60 });
    ptr(svg, "pointerup", { x: 170, y: 60 });
    expect(view().x).not.toBeCloseTo(before.x, 1);
    expect(view().k).toBe(before.k);
  });

  it("arrow-walking to an off-screen card pans just enough to show it", async () => {
    await mount(bigFleet);
    fireEvent.click(card("W0") as HTMLElement);
    const before = view();
    for (let i = 0; i < 12; i++) {
      const sel = $("[data-org-inspector]")?.dataset.orgInspector as string;
      fireEvent.keyDown(card(sel) as HTMLElement, { key: "ArrowRight" });
    }
    expect($("[data-org-inspector]")?.dataset.orgInspector).toBe("W12");
    expect(view().x).toBeLessThan(before.x);
  });
});
