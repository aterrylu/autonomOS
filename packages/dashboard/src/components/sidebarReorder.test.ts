import { describe, expect, it } from "vitest";
import { dropEdgeAt, flatDropIndex, insertionBoundary } from "./sidebarReorder";

function applyReorder(arr: string[], from: number, to: number): string[] {
  const a = [...arr];
  const [m] = a.splice(from, 1);
  a.splice(to, 0, m);
  return a;
}

describe("dropEdgeAt", () => {
  it("top half → above, bottom half → below", () => {
    const rect = { top: 100, height: 40 }; // midpoint 120
    expect(dropEdgeAt(105, rect)).toBe("above");
    expect(dropEdgeAt(135, rect)).toBe("below");
    expect(dropEdgeAt(120, rect)).toBe("below"); // exactly the midpoint
  });
});

describe("insertionBoundary — the drag-gap slot", () => {
  it("above hovers on the row, below hovers past it", () => {
    expect(insertionBoundary(2, "above")).toBe(2);
    expect(insertionBoundary(2, "below")).toBe(3);
    expect(insertionBoundary(0, "above")).toBe(0);
  });

  it("the gap slot is where the commit lands (indicated == committed)", () => {
    // Drag row 0 downward, hovering row 2's lower half: the gap opens at
    // boundary 3, and the row lands at index 2 (boundary − 1, since row 0 is
    // removed first). Same boundary drives both the preview and the commit.
    const edge = "below";
    const overIdx = 2;
    const from = 0;
    const boundary = insertionBoundary(overIdx, edge);
    expect(boundary).toBe(3);
    expect(flatDropIndex(from, overIdx, edge)).toBe(boundary - 1);
  });
});

describe("flatDropIndex — indicated == committed", () => {
  const arr = ["A", "B", "C", "D", "E"];

  it("downward drag lands BELOW the row the line was under (the old off-by-one)", () => {
    // drag A(0), hover C(2) on its lower half → line below C → A lands after C
    const to = flatDropIndex(0, 2, "below");
    expect(to).toBe(2);
    expect(applyReorder(arr, 0, to as number)).toEqual([
      "B",
      "C",
      "A",
      "D",
      "E",
    ]);
  });

  it("upward drag lands ABOVE the hovered row", () => {
    const to = flatDropIndex(4, 1, "above"); // drag E, above B
    expect(to).toBe(1);
    expect(applyReorder(arr, 4, to as number)).toEqual([
      "A",
      "E",
      "B",
      "C",
      "D",
    ]);
  });

  it("dropping onto the boundary the item already occupies is a no-op", () => {
    expect(flatDropIndex(2, 2, "above")).toBeNull();
    expect(flatDropIndex(2, 2, "below")).toBeNull();
    expect(flatDropIndex(2, 1, "below")).toBeNull(); // below B == above C == own slot
    expect(flatDropIndex(2, 3, "above")).toBeNull(); // above D == below C == own slot
  });
});
