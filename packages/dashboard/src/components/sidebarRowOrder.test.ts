import { describe, expect, it } from "vitest";
import type { SidebarHierarchyNode } from "./mergeOrgWithSessions";
import {
  arrowForRow,
  digitForRow,
  flattenHierarchyRows,
} from "./sidebarRowOrder";

function node(
  name: string,
  sessionId: string | null,
  children: SidebarHierarchyNode[] = [],
): SidebarHierarchyNode {
  return {
    org: { name },
    session: sessionId ? { id: sessionId } : undefined,
    children,
  } as unknown as SidebarHierarchyNode;
}

describe("flattenHierarchyRows", () => {
  it("walks depth-first in render order: parent before children", () => {
    const tree = [
      node("lead", "s-lead", [node("w1", "s-w1"), node("w2", "s-w2")]),
      node("solo", "s-solo"),
    ];
    expect(flattenHierarchyRows(tree, new Set())).toEqual([
      "s-lead",
      "s-w1",
      "s-w2",
      "s-solo",
    ]);
  });

  it("skips children of a collapsed group (not on screen = not numbered)", () => {
    const tree = [
      node("lead", "s-lead", [node("w1", "s-w1")]),
      node("solo", "s-solo"),
    ];
    expect(flattenHierarchyRows(tree, new Set(["lead"]))).toEqual([
      "s-lead",
      "s-solo",
    ]);
  });

  it("skips stopped placeholder rows but still walks their children", () => {
    // A stopped manager renders a non-clickable row; its live children render.
    const tree = [node("dead-mgr", null, [node("w1", "s-w1")])];
    expect(flattenHierarchyRows(tree, new Set())).toEqual(["s-w1"]);
  });

  it("collapse matching is case-insensitive like the sidebar's toggle", () => {
    const tree = [node("Lead", "s-lead", [node("w1", "s-w1")])];
    expect(flattenHierarchyRows(tree, new Set(["lead"]))).toEqual(["s-lead"]);
  });
});

describe("digitForRow", () => {
  it("is positional 1..9", () => {
    expect(digitForRow(0, 3)).toBe(1);
    expect(digitForRow(2, 3)).toBe(3);
    expect(digitForRow(8, 12)).toBe(9);
  });

  it("rows beyond the 9th are unreachable", () => {
    expect(digitForRow(9, 12)).toBeNull();
  });

  it("a lone agent needs no hint; out-of-range is null", () => {
    expect(digitForRow(0, 1)).toBeNull();
    expect(digitForRow(-1, 3)).toBeNull();
    expect(digitForRow(3, 3)).toBeNull();
  });
});

describe("arrowForRow", () => {
  it("marks the rows directly above and below the active one", () => {
    expect(arrowForRow(0, 1)).toBe("up");
    expect(arrowForRow(2, 1)).toBe("down");
    expect(arrowForRow(1, 1)).toBeNull(); // the active row itself
    expect(arrowForRow(3, 1)).toBeNull(); // not adjacent
  });

  it("no anchor (active agent not in the list) → no arrows", () => {
    expect(arrowForRow(0, -1)).toBeNull();
    expect(arrowForRow(5, -1)).toBeNull();
  });

  it("edges: top row has no up-neighbor to mark, bottom no down", () => {
    // active at 0 → nothing shows "up"; row 1 shows "down"
    expect(arrowForRow(-1, 0)).toBeNull();
    expect(arrowForRow(1, 0)).toBe("down");
  });
});
