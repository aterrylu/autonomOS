import { describe, expect, it } from "vitest";
import {
  clampZoom,
  fitsInView,
  fitView,
  interpretWheel,
  isPanGesture,
  mapFrame,
  openView,
  revealRect,
  type View,
  viewFromMapPoint,
  viewportOnMap,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from "./viewport";

const toScreen = (v: View, wx: number, wy: number) => ({
  x: wx * v.k + v.x,
  y: wy * v.k + v.y,
});

describe("zoom", () => {
  it("zooming keeps the world point under the pointer fixed", () => {
    const v: View = { x: 37, y: -120, k: 0.8 };
    const cx = 410;
    const cy = 233;
    const wx = (cx - v.x) / v.k;
    const wy = (cy - v.y) / v.k;
    const z = zoomAt(v, 1.7, cx, cy);
    const s = toScreen(z, wx, wy);
    expect(s.x).toBeCloseTo(cx, 6);
    expect(s.y).toBeCloseTo(cy, 6);
  });

  it("clamps to 30%–200%, and a clamped zoom still keeps the pointer fixed", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    const v: View = { x: 0, y: 0, k: 1.9 };
    const z = zoomAt(v, 10, 100, 100);
    expect(z.k).toBe(ZOOM_MAX);
    const s = toScreen(z, 100 / 1.9, 100 / 1.9);
    expect(s.x).toBeCloseTo(100, 6);
  });
});

describe("fit and the opening view", () => {
  const vp = { w: 900, h: 500 };

  it("fit centers the whole chart and never zooms past 100%", () => {
    const small = fitView({ w: 400, h: 200 }, vp);
    expect(small.k).toBe(1);
    expect(small.x).toBe(250);
    // Top-anchored, not vertically centered: the tree hangs from its root.
    expect(small.y).toBe(12);
    const big = fitView({ w: 2400, h: 600 }, vp);
    expect(big.k).toBeLessThan(1);
    expect(fitsInView(big, { w: 2400, h: 600 }, vp)).toBe(true);
  });

  it("opening: a chart that fits at or above the floor opens fitted", () => {
    const c = { w: 1200, h: 400 };
    expect(openView(c, vp, { floor: 0.6, anchorX: 600 })).toEqual(
      fitView(c, vp),
    );
  });

  it("opening: a chart too big for the floor opens AT the floor, top of the tree, anchored", () => {
    const c = { w: 3200, h: 700 };
    const v = openView(c, vp, { floor: 0.6, anchorX: 1500 });
    expect(v.k).toBe(0.6);
    expect(v.y).toBe(12);
    expect(toScreen(v, 1500, 0).x).toBeCloseTo(vp.w / 2, 6);
    // …so it doesn't fit, which is exactly when the map shows.
    expect(fitsInView(v, c, vp)).toBe(false);
  });
});

describe("reveal: the view follows the selection only when it must", () => {
  const vp = { w: 800, h: 500 };
  const card = { x: 0, y: 0, w: 180, h: 54 };

  it("a card already on screen doesn't move the view", () => {
    const v: View = { x: 100, y: 100, k: 1 };
    expect(revealRect(v, card, vp)).toEqual(v);
  });

  it("a card off the right edge pans just enough to show it with the margin", () => {
    const v: View = { x: 0, y: 100, k: 1 };
    const r = revealRect(v, { ...card, x: 900 }, vp);
    expect(toScreen(r, 900 + 180, 0).x).toBeCloseTo(800 - 40, 6);
    expect(r.y).toBe(100);
  });

  it("a card above the top pans down to it", () => {
    const v: View = { x: 0, y: -300, k: 1 };
    const r = revealRect(v, { ...card, y: 100 }, vp);
    expect(toScreen(r, 0, 100).y).toBeCloseTo(40, 6);
  });
});

describe("gestures", () => {
  it("a press that moves under 4 px is a click; 4 px or more is a pan", () => {
    expect(isPanGesture(2, 2)).toBe(false);
    expect(isPanGesture(0, 3.9)).toBe(false);
    expect(isPanGesture(3, 3)).toBe(true);
  });

  const w = (o: Partial<Parameters<typeof interpretWheel>[0]> = {}) => ({
    deltaX: 5,
    deltaY: 40,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...o,
  });

  it("pan mode: two-finger scroll pans (opposite the delta, like a page)", () => {
    expect(interpretWheel(w(), "pan")).toEqual({
      kind: "pan",
      dx: -5,
      dy: -40,
    });
  });

  it("a trackpad pinch (ctrlKey) or ⌘ + scroll ALWAYS zooms, whatever the mode", () => {
    for (const mode of ["pan", "zoom"] as const) {
      expect(interpretWheel(w({ ctrlKey: true }), mode).kind).toBe("zoom");
      expect(interpretWheel(w({ metaKey: true }), mode).kind).toBe("zoom");
    }
    // Scrolling down (positive delta) zooms OUT.
    const a = interpretWheel(w({ ctrlKey: true }), "pan");
    expect(a.kind === "zoom" && a.factor < 1).toBe(true);
  });

  it("zoom mode: scroll zooms, Shift + scroll pans", () => {
    expect(interpretWheel(w(), "zoom").kind).toBe("zoom");
    expect(interpretWheel(w({ shiftKey: true }), "zoom").kind).toBe("pan");
  });
});

describe("the map", () => {
  const content = { w: 3000, h: 800 };
  const map = { w: 188, h: 120 };
  const vp = { w: 900, h: 500 };

  it("the whole chart fits inside the map, centered", () => {
    const f = mapFrame(content, map);
    expect(content.w * f.s).toBeLessThanOrEqual(map.w - 12 + 1e-9);
    expect(content.h * f.s).toBeLessThanOrEqual(map.h - 12 + 1e-9);
    expect(f.ox).toBeCloseTo((map.w - content.w * f.s) / 2, 9);
  });

  it("clicking a spot on the map centers the view there, and the outline lands on it", () => {
    const f = mapFrame(content, map);
    const v: View = { x: 0, y: 0, k: 0.8 };
    const moved = viewFromMapPoint(v, vp, f, 120, 60);
    const box = viewportOnMap(moved, vp, f);
    expect(box.x + box.w / 2).toBeCloseTo(120, 6);
    expect(box.y + box.h / 2).toBeCloseTo(60, 6);
    expect(moved.k).toBe(0.8);
  });
});
