import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
  edgePath,
  elbowPath,
  H_GAP,
  type LayoutNode,
  layoutOrg,
  PAD,
  STACK_GAP,
  STACK_INDENT,
  V_GAP,
} from "./layout";

const n = (id: string, ...children: LayoutNode[]): LayoutNode => ({
  id,
  children,
});

describe("layoutOrg", () => {
  it("lays teams out SIDE BY SIDE, not in one column (F7)", () => {
    const L = layoutOrg([n("A", n("a1")), n("B", n("b1"))]);
    const a = L.pos.get("A");
    const b = L.pos.get("B");
    expect(a?.y).toBe(PAD);
    expect(b?.y).toBe(PAD); // same row
    // B starts after all of A's team, with the double team gap.
    expect(b?.x ?? 0).toBeGreaterThanOrEqual((a?.x ?? 0) + CARD_W + H_GAP * 2);
  });

  it("STACKS a lead's leaf reports in a column under it (Terry's density pick C)", () => {
    const L = layoutOrg([n("M", n("r1"), n("r2"), n("r3"))]);
    const r1 = L.pos.get("r1");
    const r2 = L.pos.get("r2");
    const r3 = L.pos.get("r3");
    expect(r1?.y).toBe(PAD + CARD_H + V_GAP);
    expect(r2?.y).toBe((r1?.y ?? 0) + CARD_H + STACK_GAP);
    expect(r3?.y).toBe((r2?.y ?? 0) + CARD_H + STACK_GAP);
    expect(new Set([r1?.x, r2?.x, r3?.x]).size).toBe(1); // one column
    expect(L.stacked.get("r2")?.column).toEqual(["r1", "r2", "r3"]);
    // The spine sits in the indent, left of the cards.
    const spine = L.stacked.get("r1")?.spineX ?? 0;
    expect(spine).toBeLessThan(r1?.x ?? 0);
    expect(spine).toBeGreaterThan((r1?.x ?? 0) - STACK_INDENT);
    expect(L.edges).toEqual([
      { from: "M", to: "r1" },
      { from: "M", to: "r2" },
      { from: "M", to: "r3" },
    ]);
  });

  it("width grows with TEAMS, not agents: 12 reports stack into one column", () => {
    const wide = layoutOrg([
      n("M", ...Array.from({ length: 12 }, (_, i) => n(`r${i}`))),
    ]);
    expect(wide.width).toBe(PAD * 2 + STACK_INDENT + CARD_W);
  });

  it("reports that lead teams stay SIDE BY SIDE, right of the stacked column; the manager centers over the row", () => {
    const L = layoutOrg([
      n("M", n("leaf1"), n("Sub", n("s1")), n("leaf2"), n("Sub2", n("t1"))),
    ]);
    const leaf1 = L.pos.get("leaf1");
    const sub = L.pos.get("Sub");
    const sub2 = L.pos.get("Sub2");
    const row = PAD + CARD_H + V_GAP;
    expect([leaf1?.y, sub?.y, sub2?.y]).toEqual([row, row, row]);
    expect(L.stacked.has("Sub")).toBe(false);
    expect(L.stacked.get("leaf2")?.column).toEqual(["leaf1", "leaf2"]);
    expect(sub?.x ?? 0).toBeGreaterThan((leaf1?.x ?? 0) + CARD_W);
    expect(sub2?.x ?? 0).toBeGreaterThan((sub?.x ?? 0) + CARD_W);
    // M is centered over its whole team (the row's subtree extents), which
    // here is the whole chart between the paddings.
    expect((L.pos.get("M")?.x ?? 0) + CARD_W / 2).toBeCloseTo(L.width / 2, 6);
  });

  it("a FOLDED lead (a team with no drawn children) never stacks — its chips need headroom", () => {
    const L = layoutOrg([n("M", n("leaf"), n("Folded"))], {
      isTeam: (x) => x.id === "Folded",
    });
    expect(L.stacked.has("leaf")).toBe(true);
    expect(L.stacked.has("Folded")).toBe(false);
    expect(L.pos.get("Folded")?.y).toBe(L.pos.get("leaf")?.y);
  });

  it("the chart is as tall as its tallest team (a stacked column included)", () => {
    const L = layoutOrg([n("M", n("a"), n("b"), n("c"))]);
    const cBottom = (L.pos.get("c")?.y ?? 0) + CARD_H;
    expect(L.height).toBe(cBottom + PAD);
  });

  it("puts reportless roots on the Unassigned shelf under the teams", () => {
    const L = layoutOrg([n("solo1"), n("T", n("t1")), n("solo2")]);
    const teamBottom = (L.pos.get("t1")?.y ?? 0) + CARD_H;
    expect(L.shelf?.count).toBe(2);
    expect(L.shelf?.y).toBeGreaterThan(teamBottom);
    const s1 = L.pos.get("solo1");
    const s2 = L.pos.get("solo2");
    expect(s1?.y).toBe(s2?.y);
    expect(s1?.y).toBeGreaterThan(L.shelf?.y ?? 0);
    expect(s1?.x).toBe(PAD);
  });

  it("a collapsed lead (no drawn children) stays in the team row via isTeam", () => {
    const L = layoutOrg([n("Folded"), n("T", n("t1")), n("Solo")], {
      isTeam: (x) => x.id === "Folded",
    });
    expect(L.pos.get("Folded")?.y).toBe(PAD);
    expect(L.pos.get("T")?.y).toBe(PAD);
    expect(L.shelf?.count).toBe(1);
  });

  it("with only solo agents, the shelf starts at the top", () => {
    const L = layoutOrg([n("a"), n("b")]);
    expect(L.shelf?.y).toBe(PAD);
    expect(L.height).toBeGreaterThan((L.pos.get("a")?.y ?? 0) + CARD_H);
  });

  it("never overlaps two cards in a deep, uneven fleet", () => {
    const L = layoutOrg([
      n("D", n("F", n("u"), n("c")), n("B", n("a"), n("t"), n("x", n("y")))),
      n("R"),
      n("S"),
    ]);
    const boxes = [...L.pos.values()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap =
          a.x < b.x + CARD_W &&
          b.x < a.x + CARD_W &&
          a.y < b.y + CARD_H &&
          b.y < a.y + CARD_H;
        expect(overlap).toBe(false);
      }
    }
    for (const b of boxes) {
      expect(b.x + CARD_W).toBeLessThanOrEqual(L.width);
      expect(b.y + CARD_H).toBeLessThanOrEqual(L.height);
    }
  });
});

describe("elbowPath", () => {
  it("is a straight drop when aligned, an elbow otherwise", () => {
    expect(elbowPath({ x: 0, y: 0 }, { x: 0, y: 200 })).toBe(
      `M${CARD_W / 2},${CARD_H}V200`,
    );
    const p = elbowPath({ x: 0, y: 0 }, { x: 300, y: 200 });
    expect(p.startsWith(`M${CARD_W / 2},${CARD_H}`)).toBe(true);
    expect(p.endsWith(`V200`)).toBe(true);
    expect(p).toContain("Q");
  });
});

describe("edgePath", () => {
  it("a stacked report hangs off the spine and enters its card's LEFT edge at mid-height", () => {
    const L = layoutOrg([n("M", n("r1"), n("r2"))]);
    const r2 = L.pos.get("r2");
    const d = edgePath(L, "M", "r2");
    // Ends at the card's left edge, vertically centered.
    expect(d.endsWith(`H${r2?.x}`)).toBe(true);
    const spine = L.stacked.get("r2")?.spineX;
    expect(d).toContain(`Q${spine},${(r2?.y ?? 0) + CARD_H / 2}`);
  });

  it("a side-by-side report keeps the elbow", () => {
    const L = layoutOrg([n("M", n("Sub", n("s1")))]);
    const m = L.pos.get("M");
    const sub = L.pos.get("Sub");
    expect(m && sub && edgePath(L, "M", "Sub")).toBe(
      m && sub && elbowPath(m, sub),
    );
  });

  it("unknown ids draw nothing", () => {
    expect(edgePath(layoutOrg([n("A")]), "A", "ghost")).toBe("");
  });
});
