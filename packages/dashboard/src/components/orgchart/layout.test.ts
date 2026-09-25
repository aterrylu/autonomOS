import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
  elbowPath,
  H_GAP,
  type LayoutNode,
  layoutOrg,
  PAD,
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
    expect((b?.x ?? 0) - (a?.x ?? 0)).toBe(CARD_W + H_GAP * 2);
  });

  it("centers a manager over its reports and puts reports one level down", () => {
    const L = layoutOrg([n("M", n("r1"), n("r2"))]);
    const m = L.pos.get("M");
    const r1 = L.pos.get("r1");
    const r2 = L.pos.get("r2");
    expect(r1?.y).toBe(PAD + CARD_H + V_GAP);
    expect(r2?.x).toBe((r1?.x ?? 0) + CARD_W + H_GAP);
    // Manager's center == midpoint of the two reports' centers.
    const mid = ((r1?.x ?? 0) + (r2?.x ?? 0)) / 2;
    expect(m?.x).toBe(mid);
    expect(L.edges).toEqual([
      { from: "M", to: "r1" },
      { from: "M", to: "r2" },
    ]);
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
