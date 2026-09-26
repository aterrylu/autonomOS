/**
 * The org chart canvas: pan, zoom and fit (PR 5, Terry's picks 1A/4A).
 *
 * The view (`x, y, k`) lives in a tiny store, NOT React state: a pan fires a
 * pointermove per frame, and re-rendering every card for each one is wasted
 * work. The stage transform is written straight to the DOM; only the small
 * subscribers (zoom %, the map) re-render, through `useCanvasViewSnapshot`.
 *
 * Gestures:
 * - drag EMPTY canvas → pan. A press that moves < PAN_THRESHOLD_PX is a click,
 *   and a click on empty canvas does nothing (the #425 sticky inspector).
 *   A drag that starts on a card, button or bubble is not a pan (PR 4 will
 *   give card drags a meaning — reassign — so they stay inert until then).
 * - two-finger scroll → pan; pinch / ⌘ + scroll → zoom at the pointer.
 * - touch: one finger pans empty canvas, two fingers pinch.
 * - keys while the chart has focus: F fit, 0 = 100%, + / − zoom.
 */

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  centerOn,
  clampZoom,
  fitView,
  interpretWheel,
  isPanGesture,
  openView,
  type Rect,
  revealRect,
  type Size,
  type View,
  zoomAt,
} from "./viewport";

// Unmount can run after a test (or an embedder) has removed the rAF globals;
// a missing timer API must never crash teardown.
const cancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
};
const requestFrame = (cb: FrameRequestCallback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(() => cb(performance.now()), 16) as unknown as number);

/** Terry's pick 4A: open fitted, but never below this zoom. */
export const OPEN_FLOOR = 0.6;
const STEP = 1.25;
const GLIDE_MS = 260;

/** Targets that own their pointer: a drag starting here never pans. */
const NO_PAN =
  "[data-org-card], [data-org-bubble], [data-org-minimap], button, a, input, [role='menu']";

export interface CanvasViewApi {
  zoomBy: (factor: number) => void;
  reset: () => void;
  fit: () => void;
  /** Pan just enough to show a world rect (the selection following). */
  reveal: (r: Rect) => void;
  /** Center a world point at the current zoom. */
  centerOn: (wx: number, wy: number) => void;
  /** Jump (no glide) — the map drag. */
  set: (v: View) => void;
}

export interface CanvasViewStore {
  get: () => { view: View; viewport: Size };
  subscribe: (fn: () => void) => () => void;
}

export function useCanvasView({
  viewportRef,
  stageRef,
  content,
  anchorX,
  onGestureStart,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  /** The laid-out chart size, in px at 100%. */
  content: Size;
  /** World x to center when opening at the floor (the top root's center). */
  anchorX: number;
  /** A pan/zoom began — e.g. close a context menu so it doesn't float away. */
  onGestureStart?: () => void;
}): { api: CanvasViewApi; store: CanvasViewStore } {
  const state = useRef({
    view: { x: 0, y: 0, k: 1 },
    viewport: { w: 0, h: 0 },
  });
  const listeners = useRef(new Set<() => void>());
  const snapshot = useRef(state.current);
  const opened = useRef(false);
  const anim = useRef(0);
  const live = useRef({ content, anchorX, onGestureStart });
  live.current = { content, anchorX, onGestureStart };

  const commit = useCallback(
    (view: View) => {
      state.current = { ...state.current, view };
      snapshot.current = state.current;
      const stage = stageRef.current;
      if (stage) {
        stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
        // Bubbles counter-scale through this (pick 3A: text stays readable).
        stage.style.setProperty("--org-inv-k", String(1 / view.k));
      }
      for (const fn of listeners.current) fn();
    },
    [stageRef],
  );

  const glide = useCallback(
    (to: View) => {
      cancelFrame(anim.current);
      const reduce =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      // rAF is paused in hidden tabs, so never animate there — jump instead.
      if (reduce || document.visibilityState === "hidden") return commit(to);
      const from = state.current.view;
      const t0 = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / GLIDE_MS);
        const e = 1 - (1 - p) ** 3;
        commit({
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
          k: from.k + (to.k - from.k) * e,
        });
        if (p < 1) anim.current = requestFrame(step);
      };
      anim.current = requestFrame(step);
    },
    [commit],
  );

  const api = useMemo<CanvasViewApi>(() => {
    const center = () => {
      const { w, h } = state.current.viewport;
      return [w / 2, h / 2] as const;
    };
    return {
      zoomBy: (f) => {
        const [cx, cy] = center();
        live.current.onGestureStart?.();
        glide(zoomAt(state.current.view, f, cx, cy));
      },
      reset: () => {
        const [cx, cy] = center();
        glide(zoomAt(state.current.view, 1 / state.current.view.k, cx, cy));
      },
      fit: () => {
        live.current.onGestureStart?.();
        glide(fitView(live.current.content, state.current.viewport));
      },
      reveal: (r) =>
        glide(revealRect(state.current.view, r, state.current.viewport)),
      centerOn: (wx, wy) =>
        glide(centerOn(state.current.view, wx, wy, state.current.viewport)),
      set: (v) => {
        cancelFrame(anim.current);
        commit({ ...v, k: clampZoom(v.k) });
      },
    };
  }, [glide, commit]);

  // Size tracking. Dockview keeps a hidden panel mounted at 0×0, so the
  // opening view waits for the first REAL size (pick 4A: fit, 60% floor).
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const viewport = { w: el.clientWidth, h: el.clientHeight };
      state.current = { ...state.current, viewport };
      if (viewport.w === 0 || viewport.h === 0) return;
      if (!opened.current) {
        opened.current = true;
        commit(
          openView(live.current.content, viewport, {
            floor: OPEN_FLOOR,
            anchorX: live.current.anchorX,
          }),
        );
      } else commit(state.current.view);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef, commit]);

  // The chart changed size (agents came or went): re-publish so the map and
  // its "doesn't fit" rule see the new bounds — but never move the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart size is the trigger
  useEffect(() => {
    if (opened.current) commit(state.current.view);
  }, [content.w, content.h, commit]);

  // Pointer / wheel / key gestures, as native listeners (wheel must be
  // non-passive to preventDefault the page scroll).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pan: {
      id: number;
      sx: number;
      sy: number;
      from: View;
      moved: boolean;
    } | null = null;
    let pinch: { d: number; cx: number; cy: number; from: View } | null = null;
    const local = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return [cx - r.left, cy - r.top] as const;
    };

    const down = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const [cx, cy] = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y),
          cx,
          cy,
          from: state.current.view,
        };
        pan = null;
        return;
      }
      if (e.button !== 0) return;
      if ((e.target as Element | null)?.closest?.(NO_PAN)) return;
      cancelFrame(anim.current);
      pan = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        from: state.current.view,
        moved: false,
      };
    };
    const move = (e: PointerEvent) => {
      if (pts.has(e.pointerId))
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const f = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
        commit(zoomAt(pinch.from, f, pinch.cx, pinch.cy));
        return;
      }
      if (!pan || e.pointerId !== pan.id) return;
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      if (!pan.moved) {
        if (!isPanGesture(dx, dy)) return;
        pan.moved = true;
        el.setPointerCapture?.(e.pointerId);
        el.dataset.orgPanning = "";
        live.current.onGestureStart?.();
      }
      commit({ ...pan.from, x: pan.from.x + dx, y: pan.from.y + dy });
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pan && e.pointerId === pan.id) {
        // A press that never became a pan is a plain click: nothing happens.
        delete el.dataset.orgPanning;
        pan = null;
      }
    };
    // A pan that just ended must not also count as a click on what's under it.
    const swallowClickAfterPan = (e: MouseEvent) => {
      if (el.dataset.orgJustPanned !== undefined) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const markJustPanned = () => {
      if (el.dataset.orgPanning === undefined) return;
      el.dataset.orgJustPanned = "";
      setTimeout(() => delete el.dataset.orgJustPanned, 0);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelFrame(anim.current);
      live.current.onGestureStart?.();
      const a = interpretWheel(e, "pan"); // pick 1A
      const v = state.current.view;
      if (a.kind === "pan") commit({ ...v, x: v.x + a.dx, y: v.y + a.dy });
      else {
        const [cx, cy] = local(e.clientX, e.clientY);
        commit(zoomAt(v, a.factor, cx, cy));
      }
    };
    // Safari reports a trackpad pinch as gesture events, not ctrl+wheel.
    let g0 = 1;
    const gStart = (e: Event) => {
      e.preventDefault();
      g0 = state.current.view.k;
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      const [cx, cy] = local(ge.clientX, ge.clientY);
      const v = state.current.view;
      commit(zoomAt(v, clampZoom(g0 * ge.scale) / v.k, cx, cy));
    };
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") api.fit();
      else if (e.key === "0") api.reset();
      else if (e.key === "+" || e.key === "=") api.zoomBy(STEP);
      else if (e.key === "-" || e.key === "_") api.zoomBy(1 / STEP);
      else return;
      e.preventDefault();
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", markJustPanned, true);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", swallowClickAfterPan, true);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    el.addEventListener("keydown", key);
    return () => {
      cancelFrame(anim.current);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", markJustPanned, true);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", swallowClickAfterPan, true);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gStart);
      el.removeEventListener("gesturechange", gChange);
      el.removeEventListener("keydown", key);
    };
  }, [viewportRef, commit, api]);

  const store = useMemo<CanvasViewStore>(
    () => ({
      get: () => snapshot.current,
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
    }),
    [],
  );
  return { api, store };
}

/** Subscribe a small component (zoom %, the map) to the view. */
export function useCanvasViewSnapshot(store: CanvasViewStore) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
