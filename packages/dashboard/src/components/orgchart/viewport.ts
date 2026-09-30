/**
 * Org chart canvas: pure view math (PR 5). No DOM here, so every rule the
 * canvas follows is unit-tested on its own.
 *
 * A view maps world coordinates (the laid-out chart, in px at 100%) to the
 * screen: `screen = world * k + (x, y)`.
 */

export interface View {
  x: number;
  y: number;
  k: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;
/** A press that moves less than this is a click, not a pan. */
export const PAN_THRESHOLD_PX = 4;

export function clampZoom(k: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

/** Zoom by `factor` keeping the world point under screen (cx, cy) fixed. */
export function zoomAt(v: View, factor: number, cx: number, cy: number): View {
  const k = clampZoom(v.k * factor);
  const r = k / v.k;
  return { x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r, k };
}

/** The view that shows all of `content`, centered, never above `maxK`. */
export function fitView(
  content: Size,
  viewport: Size,
  { pad = 12, maxK = 1 }: { pad?: number; maxK?: number } = {},
): View {
  const k = clampZoom(
    Math.min(
      (viewport.w - 2 * pad) / Math.max(1, content.w),
      (viewport.h - 2 * pad) / Math.max(1, content.h),
      maxK,
    ),
  );
  return {
    x: (viewport.w - content.w * k) / 2,
    // Top-anchored: a hierarchy reads down from its root, so a short chart
    // hangs from the top instead of floating mid-pane.
    y: pad,
    k,
  };
}

/**
 * The opening view: fit, but never below `floor`. When fitting would go below
 * it, open at `floor` at the top of the chart, horizontally centered on
 * `anchorX` (world x, e.g. the first root's center); the map shows the rest.
 */
export function openView(
  content: Size,
  viewport: Size,
  {
    floor,
    anchorX,
    pad = 12,
  }: { floor: number; anchorX: number; pad?: number },
): View {
  const fit = fitView(content, viewport, { pad });
  if (fit.k >= floor) return fit;
  const k = clampZoom(floor);
  return { x: viewport.w / 2 - anchorX * k, y: pad, k };
}

/** Does all of `content` sit inside the viewport under view `v`? */
export function fitsInView(v: View, content: Size, viewport: Size): boolean {
  const eps = 1;
  return (
    v.x >= -eps &&
    v.y >= -eps &&
    v.x + content.w * v.k <= viewport.w + eps &&
    v.y + content.h * v.k <= viewport.h + eps
  );
}

/**
 * The smallest pan that brings world rect `r` inside the viewport with a
 * `margin`. Unchanged when it is already visible (the view "follows" the
 * selection only when it has to).
 */
export function revealRect(
  v: View,
  r: Rect,
  viewport: Size,
  margin = 40,
): View {
  const sx = v.x + r.x * v.k;
  const sy = v.y + r.y * v.k;
  const sw = r.w * v.k;
  const sh = r.h * v.k;
  let { x, y } = v;
  if (sx < margin) x += margin - sx;
  else if (sx + sw > viewport.w - margin) x -= sx + sw - (viewport.w - margin);
  if (sy < margin) y += margin - sy;
  else if (sy + sh > viewport.h - margin) y -= sy + sh - (viewport.h - margin);
  return { x, y, k: v.k };
}

/** The view that centers world point (wx, wy) at the current zoom. */
export function centerOn(
  v: View,
  wx: number,
  wy: number,
  viewport: Size,
): View {
  return { x: viewport.w / 2 - wx * v.k, y: viewport.h / 2 - wy * v.k, k: v.k };
}

/** Has a press moved far enough to be a pan instead of a click? */
export function isPanGesture(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= PAN_THRESHOLD_PX;
}

/** What a scroll-wheel / two-finger scroll does (Terry's pick 1). */
export type WheelMode = "pan" | "zoom";
export type WheelAction =
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; factor: number };

/**
 * Interpret a wheel event. A trackpad pinch arrives as `ctrlKey` + wheel in
 * Chromium/Firefox and always zooms, as does ⌘ + scroll. Otherwise the mode
 * decides: "pan" moves the view; "zoom" zooms, with Shift + scroll panning.
 */
export function interpretWheel(
  e: {
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
  mode: WheelMode,
): WheelAction {
  if (e.ctrlKey) return { kind: "zoom", factor: Math.exp(-e.deltaY * 0.012) };
  if (e.metaKey || (mode === "zoom" && !e.shiftKey))
    return { kind: "zoom", factor: Math.exp(-e.deltaY * 0.0025) };
  return { kind: "pan", dx: -e.deltaX, dy: -e.deltaY };
}

/** How the whole chart is drawn inside the map (scale + offset). */
export interface MapFrame {
  s: number;
  ox: number;
  oy: number;
}

export function mapFrame(content: Size, map: Size, pad = 6): MapFrame {
  const s = Math.min(
    (map.w - 2 * pad) / Math.max(1, content.w),
    (map.h - 2 * pad) / Math.max(1, content.h),
  );
  return {
    s,
    ox: (map.w - content.w * s) / 2,
    oy: (map.h - content.h * s) / 2,
  };
}

/** The viewport's outline on the map. */
export function viewportOnMap(v: View, viewport: Size, f: MapFrame): Rect {
  return {
    x: f.ox + (-v.x / v.k) * f.s,
    y: f.oy + (-v.y / v.k) * f.s,
    w: (viewport.w / v.k) * f.s,
    h: (viewport.h / v.k) * f.s,
  };
}

/** Clicking/dragging the map at (px, py) centers the view on that spot. */
export function viewFromMapPoint(
  v: View,
  viewport: Size,
  f: MapFrame,
  px: number,
  py: number,
): View {
  return centerOn(v, (px - f.ox) / f.s, (py - f.oy) / f.s, viewport);
}
