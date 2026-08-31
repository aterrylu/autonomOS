import { describe, expect, it } from "vitest";
import { hierDropIndex, reorderLiveInFullOrder } from "./hierarchyReorder";

describe("hierDropIndex", () => {
  it("same geometry as flat (down→below, up→above, own-slot→null)", () => {
    expect(hierDropIndex(0, 2, "below")).toBe(2);
    expect(hierDropIndex(2, 0, "above")).toBe(0);
    expect(hierDropIndex(1, 1, "above")).toBeNull();
  });
});

describe("reorderLiveInFullOrder — stopped names keep their slots (nox Thread-1)", () => {
  it("all-live: plain reorder", () => {
    expect(
      reorderLiveInFullOrder(["a", "b", "c"], ["a", "b", "c"], 0, 1),
    ).toEqual(["b", "a", "c"]);
  });

  it("a STOPPED child between live siblings is not moved or mis-indexed", () => {
    // Persisted order keeps the stopped name; the tree (hideStopped) does not.
    const full = ["a", "stopped", "b", "c"];
    const live = ["a", "b", "c"];
    // Move live 'a' (live index 0) to after 'b' (live index 1).
    const out = reorderLiveInFullOrder(full, live, 0, 1);
    // Live projection is the intended reorder…
    expect(out.filter((n) => n !== "stopped")).toEqual(["b", "a", "c"]);
    // …and the stopped name kept its absolute slot (the old index-based splice
    // would have moved 'a' to where 'stopped' sits and left the live order
    // effectively unchanged — the wrong-sibling bug).
    expect(out.indexOf("stopped")).toBe(1);
  });

  it("a fresh live sibling missing from the persisted order still lands", () => {
    const out = reorderLiveInFullOrder(["a", "b"], ["a", "b", "c"], 2, 0);
    expect(out.filter((n) => ["a", "b", "c"].includes(n))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
