import { describe, expect, it } from "vitest";
import { orderedPaneIds } from "./orderedPaneIds";

function leaf(...views: string[]) {
  return { type: "leaf", data: { views, activeView: views[0], id: "g" } };
}

function grid(root: unknown) {
  return { grid: { root, width: 800, height: 600, orientation: "HORIZONTAL" } };
}

describe("orderedPaneIds", () => {
  it("returns a single group's views in tab order", () => {
    expect(orderedPaneIds(grid(leaf("a", "b", "c")))).toEqual(["a", "b", "c"]);
  });

  it("walks branches depth-first in spatial order", () => {
    // Visual layout: [A | C] | B — the exact shape where api.panels lies.
    // Split right (B created 2nd), then split the LEFT group again (C created
    // 3rd): insertion order is A,B,C but spatial order is A,C,B. The serialized
    // grid tree nests A and C inside the left branch, in spatial order.
    const root = {
      type: "branch",
      data: [{ type: "branch", data: [leaf("A"), leaf("C")] }, leaf("B")],
    };
    expect(orderedPaneIds(grid(root))).toEqual(["A", "C", "B"]);
  });

  it("handles deeply nested splits", () => {
    const root = {
      type: "branch",
      data: [
        leaf("1"),
        {
          type: "branch",
          data: [leaf("2", "3"), { type: "branch", data: [leaf("4")] }],
        },
      ],
    };
    expect(orderedPaneIds(grid(root))).toEqual(["1", "2", "3", "4"]);
  });

  it("is defensive against malformed shapes", () => {
    expect(orderedPaneIds(grid(null))).toEqual([]);
    expect(orderedPaneIds(grid({ type: "leaf", data: null }))).toEqual([]);
    expect(
      orderedPaneIds(grid({ type: "leaf", data: { views: "x" } })),
    ).toEqual([]);
    expect(
      orderedPaneIds(grid({ type: "branch", data: [{ type: "leaf" }, 42] })),
    ).toEqual([]);
    expect(
      orderedPaneIds(
        grid({ type: "leaf", data: { views: ["ok", 7, "also"] } }),
      ),
    ).toEqual(["ok", "also"]);
    expect(orderedPaneIds({ grid: { root: undefined } })).toEqual([]);
  });

  it("bails out on pathological depth instead of overflowing", () => {
    let node: unknown = leaf("deep");
    for (let i = 0; i < 100; i++) node = { type: "branch", data: [node] };
    expect(orderedPaneIds(grid(node))).toEqual([]);
  });
});
