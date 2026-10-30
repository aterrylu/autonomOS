import { describe, expect, it } from "vitest";
import {
  arcPath,
  CARD_H,
  CARD_W,
  COL_GAP,
  edgePath,
  elbowPath,
  H_GAP,
  type LayoutNode,
  layoutOrg,
  PAD,
  STACK_GAP,
  STACK_INDENT,
  TEAM_GAP,
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

describe("arcPath (a message that isn't a manager edge)", () => {
  // The control point is the Q's first coordinate pair.
  const control = (d: string) =>
    (/Q(-?[\d.]+),(-?[\d.]+)/.exec(d) ?? []).slice(1).map(Number);

  it("top-down: bows ABOVE both cards", () => {
    const L = layoutOrg([n("M", n("Sub", n("s1")), n("Sub2", n("s2")))]);
    const a = L.pos.get("Sub");
    const b = L.pos.get("Sub2");
    if (!a || !b) throw new Error("cards not placed");
    const [, cy] = control(arcPath(L, a, b));
    expect(cy).toBeLessThan(Math.min(a.y, b.y));
  });

  it("top-down: siblings in a stacked column share an x, so it bows to their RIGHT", () => {
    const L = layoutOrg([n("M", n("r1"), n("r2"), n("r3"))]);
    const a = L.pos.get("r1");
    const b = L.pos.get("r3");
    if (!a || !b) throw new Error("cards not placed");
    expect(a.x).toBe(b.x); // precondition: one column
    const [cx] = control(arcPath(L, a, b));
    expect(cx).toBeGreaterThan(a.x + CARD_W);
  });

  it("left-right: peers share a column, so it bows to their RIGHT, clear of the cards between", () => {
    const L = layoutOrg([n("M", n("r1"), n("r2"), n("r3"))], {
      direction: "lr",
    });
    const a = L.pos.get("r1");
    const b = L.pos.get("r3");
    if (!a || !b) throw new Error("cards not placed");
    expect(a.x).toBe(b.x); // precondition: one column
    const d = arcPath(L, a, b);
    const [cx] = control(d);
    expect(cx).toBeGreaterThan(a.x + CARD_W);
    expect(d.startsWith(`M${a.x + CARD_W},${a.y + CARD_H / 2}`)).toBe(true);
    expect(d.endsWith(`${b.x + CARD_W},${b.y + CARD_H / 2}`)).toBe(true);
  });
});

describe("layoutOrg — left→right", () => {
  const lr = (roots: LayoutNode[], isTeam?: (n: LayoutNode) => boolean) =>
    layoutOrg(roots, { direction: "lr", isTeam });
  const col = (depth: number) => PAD + depth * (CARD_W + COL_GAP);

  it("puts the root on the LEFT and each level one column to its right", () => {
    const L = lr([n("R", n("L", n("w1")))]);
    expect(L.direction).toBe("lr");
    expect(L.pos.get("R")?.x).toBe(col(0));
    expect(L.pos.get("L")?.x).toBe(col(1));
    expect(L.pos.get("w1")?.x).toBe(col(2));
  });

  it("stacks reports top to bottom and centers the manager on them", () => {
    const L = lr([n("M", n("r1"), n("r2"), n("r3"))]);
    const ys = ["r1", "r2", "r3"].map((id) => L.pos.get(id)?.y ?? 0);
    expect(ys[1] - ys[0]).toBe(CARD_H + STACK_GAP);
    expect(ys[2] - ys[1]).toBe(CARD_H + STACK_GAP);
    expect(L.pos.get("M")?.y).toBe((ys[0] + ys[2]) / 2);
    expect(L.stacked.size).toBe(0); // no spine columns here
  });

  it("width grows with DEPTH, not agents: 30 reports are still two columns", () => {
    const L = lr([n("M", ...Array.from({ length: 30 }, (_, i) => n(`r${i}`)))]);
    expect(L.width).toBe(PAD * 2 + 2 * CARD_W + COL_GAP);
  });

  it("sibling TEAMS get room for a lead's rollup chips (19px above its card)", () => {
    const L = lr([n("R", n("A", n("a1")), n("B", n("b1")))]);
    const a = L.pos.get("A")?.y ?? 0;
    const b = L.pos.get("B")?.y ?? 0;
    expect(b - (a + CARD_H)).toBeGreaterThanOrEqual(TEAM_GAP);
    expect(TEAM_GAP).toBeGreaterThan(19);
  });

  it("never overlaps two cards, and every lead's chip strip is clear, in a deep uneven fleet", () => {
    const L = lr([
      n(
        "R",
        n("A", n("a1"), n("a2", n("x1"), n("x2"))),
        n("b"),
        n("C", n("c1")),
      ),
      n("S", n("s1")),
      n("solo"),
    ]);
    const boxes = [...L.pos.entries()];
    for (const [i, [, p]] of boxes.entries())
      for (const [, q] of boxes.slice(i + 1)) {
        const apart =
          p.x + CARD_W <= q.x ||
          q.x + CARD_W <= p.x ||
          p.y + CARD_H <= q.y ||
          q.y + CARD_H <= p.y;
        expect(apart).toBe(true);
      }
    // A lead's chips occupy [y-19, y) over its column: nothing else may.
    for (const lead of ["R", "A", "a2", "C", "S"]) {
      const p = L.pos.get(lead) as { x: number; y: number };
      for (const [id, q] of boxes) {
        if (id === lead || q.x !== p.x) continue;
        const clear = q.y + CARD_H <= p.y - 19 || q.y >= p.y;
        expect(clear, `${id} under ${lead}'s chips`).toBe(true);
      }
    }
  });

  it("solo agents still sit on the Unassigned shelf under the teams", () => {
    const L = lr([n("M", n("r")), n("solo")]);
    const shelfY = L.shelf?.y ?? 0;
    expect(L.shelf?.count).toBe(1);
    expect(L.pos.get("solo")?.y ?? 0).toBeGreaterThan(shelfY);
    expect(shelfY).toBeGreaterThan((L.pos.get("r")?.y ?? 0) + CARD_H);
  });

  it("connectors run sideways: manager's RIGHT-middle → report's LEFT-middle", () => {
    const L = lr([n("M", n("r1"), n("r2"))]);
    const m = L.pos.get("M") as { x: number; y: number };
    const r2 = L.pos.get("r2") as { x: number; y: number };
    const d = edgePath(L, "M", "r2");
    expect(d.startsWith(`M${m.x + CARD_W},${m.y + CARD_H / 2}`)).toBe(true);
    expect(d.endsWith(`H${r2.x}`)).toBe(true);
    expect(d).toContain(`,${r2.y + CARD_H / 2}`);
  });
});
