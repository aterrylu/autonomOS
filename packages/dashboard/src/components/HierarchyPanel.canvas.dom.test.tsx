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

/**
 * `n` teams side by side under one root. Reports STACK (density pick C), so a
 * chart grows wide with TEAMS: 8 teams are too wide for the 60% floor but fit
 * above 30%; 16 are too wide even at 30%.
 */
function bigFleet(n = 8) {
  const leads = Array.from({ length: n }, (_, i) =>
    node(`L${i}`, [node(`L${i}a`), node(`L${i}b`)]),
  );
  stubTree([node("Lead", leads)]);
  useStore.setState({
    theme: "void",
    sessions: [
      "Lead",
      ...leads.flatMap((l) => [l.id, ...l.children.map((c) => c.id)]),
    ].map(session),
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
  const v = stage().dataset.orgView;
  if (!v) throw new Error("no view published on the stage");
  const [x, y, k] = v.split(",").map(Number);
  return { x, y, k };
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
  await waitFor(() => expect(stage().dataset.orgView).toBeTruthy());
}

describe('crisp at every zoom (Terry: "the cards look very low quality")', () => {
  it("zoom is CSS `zoom` on the stage — never a scale transform (which blurs a stretched bitmap)", async () => {
    await mount(() => bigFleet(8));
    expect(stage().style.transform).toBe("");
    expect(stage().style.zoom).toBe(String(view().k));
    // Pan rides a wrapper as a WHOLE-PIXEL translate (subpixel blurs text too).
    const pan = $("[data-org-pan]") as HTMLElement;
    act(() => {
      fireEvent.wheel(viewport(), { deltaY: -37, ctrlKey: true }); // fractional view
    });
    const m = pan.style.transform.match(/^translate\((-?\d+)px, (-?\d+)px\)$/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(Math.round(view().x));
    expect(pan.style.transform).not.toContain("scale");
  });

  it("message bubbles counter-ZOOM (1:1 text), not counter-scale", async () => {
    // The bubble layer reads --org-inv-k through `zoom`; a `scale` there would
    // stretch the bubble's bitmap at every zoom but 100%.
    await mount(() => bigFleet(8));
    expect(Number(stage().style.getPropertyValue("--org-inv-k"))).toBeCloseTo(
      1 / view().k,
      6,
    );
  });
});

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
      1 + 8 * 3,
    );
  });
});

describe("pan (drag EMPTY canvas)", () => {
  it("dragging empty canvas pans; the selection and inspector stay (the #425 rule)", async () => {
    await mount(bigFleet);
    fireEvent.click(card("L0a") as HTMLElement);
    expect($("[data-org-inspector]")).not.toBeNull();
    const before = view();
    drag(stage(), -120, 40);
    const after = view();
    expect(after.x).toBeCloseTo(before.x - 120, 6);
    expect(after.y).toBeCloseTo(before.y + 40, 6);
    expect($("[data-org-inspector]")?.dataset.orgInspector).toBe("L0a");
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
    drag(card("L0a") as HTMLElement, -150, 0);
    expect(view()).toEqual(before);
  });

  it("a scroll-pan or zoom closes an open context menu so it never floats off its card", async () => {
    // A drag already closes it (the menu's own outside-pointerdown); a wheel
    // sends no pointerdown, so the canvas must close it itself.
    await mount(bigFleet);
    fireEvent.contextMenu(card("L0a") as HTMLElement, {
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
    // 8 teams: too wide for the 60% floor, but Fit can show them all.
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

describe("the viewport never moves on its own (nox, #430)", () => {
  it("a native scroll (focus() / scrollIntoView on an overflow-hidden box) is undone at once", async () => {
    await mount(() => bigFleet());
    const before = view();
    const vp = viewport();
    vp.scrollLeft = 240;
    vp.scrollTop = 60;
    act(() => {
      vp.dispatchEvent(new Event("scroll"));
    });
    expect(vp.scrollLeft).toBe(0);
    expect(vp.scrollTop).toBe(0);
    expect(view()).toEqual(before);
  });

  it("keyboard focus reaching an off-screen card pans the canvas to it", async () => {
    await mount(() => bigFleet());
    const before = view();
    act(() => {
      (card("L7") as HTMLElement).focus();
    });
    expect(view().x).toBeLessThan(before.x);
    expect(view().k).toBe(before.k);
  });

  it("touch gestures belong to the canvas (touch-action: none), not the browser", async () => {
    await mount(() => bigFleet());
    expect(viewport().className).toContain("touch-none");
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
    await mount(() => bigFleet(8));
    fireEvent.click(card("L0") as HTMLElement);
    const before = view();
    for (let i = 0; i < 7; i++) {
      const sel = $("[data-org-inspector]")?.dataset.orgInspector as string;
      fireEvent.keyDown(card(sel) as HTMLElement, { key: "ArrowRight" });
    }
    expect($("[data-org-inspector]")?.dataset.orgInspector).toBe("L7");
    // The invariant: the selected card is ON SCREEN (the view followed it).
    const c = card("L7") as HTMLElement;
    const v = view();
    const sx = v.x + Number.parseFloat(c.style.left) * v.k;
    const sy = v.y + Number.parseFloat(c.style.top) * v.k;
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sx + 200 * v.k).toBeLessThanOrEqual(VP.w);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sy + 60 * v.k).toBeLessThanOrEqual(VP.h);
    // …and it had to move to get there (L7 starts off-screen).
    expect(v).not.toEqual(before);
  }, 15_000);
});

describe("two top-level teams: both stay in view as agents come and go (Terry's bug)", () => {
  const team = (lead: string, n: number) =>
    node(
      lead,
      Array.from({ length: n }, (_, i) => node(`${lead}-${i}`)),
    );
  const ids = (roots: AgentTreeNode[]): string[] =>
    roots.flatMap((r) => [r.id, ...ids(r.children)]);
  const setFleet = (roots: AgentTreeNode[]) => {
    stubTree(roots);
    useStore.setState({
      theme: "void",
      sessions: ids(roots).map(session),
      exitedSessions: [],
      agentStatuses: {},
      notificationCounts: {},
    });
  };
  const swap = async (roots: AgentTreeNode[]) => {
    setFleet(roots);
    await act(async () => {
      await orgTreePoll.refresh();
    });
  };
  // Would card `id` (at its CURRENT layout position) sit fully on screen
  // under view `v`? With an older view, this is where the bug left it.
  const fullyOnScreenUnder = (
    v: { x: number; y: number; k: number },
    id: string,
  ) => {
    const { x, y, k } = v;
    const c = card(id) as HTMLElement;
    const left = x + Number.parseFloat(c.style.left) * k;
    const top = y + Number.parseFloat(c.style.top) * k;
    return (
      left >= 0 && top >= 0 && left + 200 * k <= VP.w && top + 60 * k <= VP.h
    );
  };
  const fullyOnScreen = (id: string) => fullyOnScreenUnder(view(), id);

  it("a second team that arrives after the chart opened is shown beside the first", async () => {
    await mount(() => setFleet([team("Lead", 3)]));
    const opened = view();
    await swap([team("Lead", 3), team("Other", 1)]);
    await waitFor(() => expect(card("Other")).not.toBeNull());
    // Precondition: the view it opened with would strand the new team.
    expect(fullyOnScreenUnder(opened, "Other")).toBe(false);
    expect(fullyOnScreen("Lead")).toBe(true);
    expect(fullyOnScreen("Other")).toBe(true);
    expect(fullyOnScreen("Other-0")).toBe(true);
  });

  it("removing the team on screen leaves the other team on screen, not an empty chart", async () => {
    // Too wide for the 60% floor: the chart opens on the first team, and
    // the second starts off-screen (asserted, so this can't pass vacuously).
    await mount(() => setFleet([team("Lead", 10), team("Other", 1)]));
    expect(fullyOnScreen("Other")).toBe(false);
    await swap([team("Other", 1)]);
    await waitFor(() => expect(card("Lead")).toBeNull());
    expect(fullyOnScreen("Other")).toBe(true);
    expect(fullyOnScreen("Other-0")).toBe(true);
  });

  it("a view you moved stays put while any card is still on screen (ADR-120's intent)", async () => {
    await mount(() => setFleet([team("Lead", 3), team("Other", 1)]));
    drag(stage(), -40, 0);
    const before = view();
    await swap([team("Lead", 3), team("Other", 2)]);
    await waitFor(() => expect(card("Other-1")).not.toBeNull());
    expect(view()).toEqual(before);
  });

  it("clicking a card (which focuses it) doesn't count as placing the view", async () => {
    await mount(() => setFleet([team("Lead", 3)]));
    fireEvent.click(card("Lead") as HTMLElement);
    (card("Lead") as HTMLElement).focus();
    await swap([team("Lead", 3), team("Other", 1)]);
    await waitFor(() => expect(card("Other")).not.toBeNull());
    expect(fullyOnScreen("Other")).toBe(true);
  });

  it("a change made while the pane was hidden (0×0) is re-checked when it shows again", async () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    const resize = () =>
      act(() => {
        for (const cb of observers) cb();
      });
    await mount(() => setFleet([team("Lead", 10), team("Other", 1)]));
    expect(observers.length).toBeGreaterThan(0);
    const before = view();
    VP = { w: 0, h: 0 }; // dockview hides the pane
    resize();
    await swap([team("Other", 1)]); // the visible team is removed meanwhile
    await waitFor(() => expect(card("Lead")).toBeNull());
    expect(view()).toEqual(before); // nothing to frame at 0×0
    VP = { w: 900, h: 500 }; // the pane shows again
    resize();
    expect(fullyOnScreen("Other")).toBe(true);
    expect(fullyOnScreen("Other-0")).toBe(true);
  });

  it("after Fit, a fleet change fits again (not the 60% opening floor)", async () => {
    await mount(() => setFleet([team("Lead", 10), team("Other", 1)]));
    fireEvent.click($("[data-org-zoom-fit]") as HTMLElement);
    await waitFor(() => expect(fullyOnScreen("Other")).toBe(true));
    await swap([team("Lead", 10), team("Other", 2)]);
    await waitFor(() => expect(card("Other-1")).not.toBeNull());
    for (const id of ["Lead", "Lead-0", "Lead-9", "Other", "Other-1"])
      expect(fullyOnScreen(id), id).toBe(true);
    expect(view().k).toBeLessThan(0.6);
  });

  it("a pinch-zoomed view stays put while a card is still on screen", async () => {
    await mount(() => setFleet([team("Lead", 3), team("Other", 1)]));
    const vp = viewport();
    act(() => {
      vp.dispatchEvent(new Event("gesturestart", { cancelable: true }));
      vp.dispatchEvent(
        Object.assign(new Event("gesturechange", { cancelable: true }), {
          scale: 1.2,
          clientX: 300,
          clientY: 200,
        }),
      );
    });
    const pinched = view();
    await swap([team("Lead", 3), team("Other", 2)]);
    await waitFor(() => expect(card("Other-1")).not.toBeNull());
    expect(view()).toEqual(pinched);
  });
});
