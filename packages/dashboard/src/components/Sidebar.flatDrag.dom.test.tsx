// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * DOM-level drag WIRING for flat-view reorder. The reorder math is covered by
 * the sidebarReorder unit tests; here we fire synthetic HTML5 drag events on the
 * rendered rows to verify dragStart→dragOver→drop→reorderFlat is wired with the
 * correct section + keys, that a cross-section drop is a no-op (the
 * section-clamping guard), and — crucially — that a drop landing in the OPENED
 * GAP (on the sidebar container, not a row) still commits. The commit authority
 * is the <aside> onDrop, not the row: the slide-apart ghost has
 * pointerEvents:none, so an upper-half hover drops through it onto the container
 * (nox 🔴). A row-target drop reaches the same handler by bubbling.
 *
 * handleDragOver now reads the MIDPOINT of the hovered row (`dropEdgeAt` on
 * `e.clientY` + the row's rect) to pick the above/below insertion edge. jsdom
 * gives every element a zero rect, so we mock a fixed 20px-tall row and pass an
 * explicit `clientY` per drag to exercise the intended half — the same edge the
 * gold line is drawn on and the commit index is derived from.
 */

const AGENT_IDS = ["a", "b", "c"];
const ROW_TOP = 0;
const ROW_H = 20;
/** clientY in the row's top half (insert ABOVE) / bottom half (insert BELOW). */
const ABOVE_Y = ROW_TOP + ROW_H * 0.25;
const BELOW_Y = ROW_TOP + ROW_H * 0.75;

function sess(id: string): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    claudeSessionId: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

function stubFetch(ids: string[]) {
  const agents = ids.map((id) => ({
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    createdAt: 1,
    updatedAt: 1,
  }));
  // Real `Response` objects — the api client reads the body via `res.text()`.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      if (u.includes("/api/agents") && !u.includes("/tree")) body = agents;
      else if (u.includes("/api/agents") || u.includes("/api/projects"))
        body = [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
}

/** A synthetic dataTransfer good enough for the drag handlers. */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

/** The draggable row element for an agent (the role=button ancestor). */
function row(name: string): HTMLElement {
  const el = screen.getByText(name).closest('[role="button"]');
  if (!el) throw new Error(`row not found for ${name}`);
  return el as HTMLElement;
}

/**
 * Fire a native drag event. jsdom's `DragEvent` ctor DROPS `clientY` passed via
 * `fireEvent.dragOver(el, {clientY})`, so we build the event and set the coord as
 * an own property (React reads `clientY`/`dataTransfer` off the native event) —
 * the only way to exercise the midpoint hit-test at the DOM level.
 */
function fireDrag(
  type: "dragStart" | "dragOver" | "drop",
  el: HTMLElement,
  opts: { dataTransfer?: unknown; clientY?: number },
) {
  const ev = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
  if (opts.dataTransfer !== undefined)
    (ev as unknown as { dataTransfer: unknown }).dataTransfer =
      opts.dataTransfer;
  if (opts.clientY !== undefined)
    (ev as unknown as { clientY: number }).clientY = opts.clientY;
  fireEvent(el, ev);
}

function renderSidebar() {
  return render(<Sidebar />);
}

beforeEach(() => {
  // jsdom returns a zero rect for everything; give rows a fixed height so the
  // midpoint hit-test (`dropEdgeAt`) has a real box to split.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: ROW_TOP,
    height: ROW_H,
    bottom: ROW_TOP + ROW_H,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: ROW_TOP,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("flat-view drag wiring", () => {
  it("reorders within the unpinned section via drag events", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: [],
      unpinnedOrder: ["a", "b", "c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Drag 'a' (idx 0) onto 'c' (idx 2), lower half → insert BELOW c.
    fireDrag("dragStart", row("a"), { dataTransfer: dt });
    fireDrag("dragOver", row("c"), { dataTransfer: dt, clientY: BELOW_Y });
    fireDrag("drop", row("c"), { dataTransfer: dt });

    expect(useStore.getState().unpinnedOrder).toEqual(["b", "c", "a"]);
    expect(useStore.getState().pinnedOrder).toEqual([]);
  });

  it("commits a drop that lands in the opened gap, not on a row (nox 🔴 dead-zone)", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: [],
      unpinnedOrder: ["a", "b", "c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Drag 'a' down; hover 'c' UPPER half → a gap opens BEFORE 'c' and the cursor
    // sits inside the ghost (pointerEvents:none), so the real drop lands on the
    // sidebar container, NEVER on row('c'). Dropping on the <aside> reproduces
    // that fall-through — the old code committed nothing here (silent cancel).
    fireDrag("dragStart", row("a"), { dataTransfer: dt });
    fireDrag("dragOver", row("c"), { dataTransfer: dt, clientY: ABOVE_Y });
    const aside = row("c").closest("aside");
    if (!aside) throw new Error("no <aside>");
    fireDrag("drop", aside as HTMLElement, { dataTransfer: dt });

    // 'a' lands BEFORE 'c', where the gap was: [b, a, c].
    expect(useStore.getState().unpinnedOrder).toEqual(["b", "a", "c"]);
  });

  it("ignores a cross-section drop (pinned ↔ unpinned)", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: ["a"],
      unpinnedOrder: ["b", "c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Start dragging 'b' (unpinned) and drop onto 'a' (pinned) — must be a no-op.
    fireDrag("dragStart", row("b"), { dataTransfer: dt });
    fireDrag("dragOver", row("a"), { dataTransfer: dt, clientY: BELOW_Y });
    fireDrag("drop", row("a"), { dataTransfer: dt });

    expect(useStore.getState().pinnedOrder).toEqual(["a"]);
    expect(useStore.getState().unpinnedOrder).toEqual(["b", "c"]);
  });

  it("reorders within the pinned section without touching unpinned", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: ["a", "b"],
      unpinnedOrder: ["c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Drag 'b' (pinned idx 1) onto 'a' (pinned idx 0), upper half → insert ABOVE a.
    fireDrag("dragStart", row("b"), { dataTransfer: dt });
    fireDrag("dragOver", row("a"), { dataTransfer: dt, clientY: ABOVE_Y });
    fireDrag("drop", row("a"), { dataTransfer: dt });

    expect(useStore.getState().pinnedOrder).toEqual(["b", "a"]);
    expect(useStore.getState().unpinnedOrder).toEqual(["c"]);
  });
});
