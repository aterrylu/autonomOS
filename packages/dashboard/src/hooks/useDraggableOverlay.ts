/**
 * Drag-to-reposition for an absolutely-positioned overlay inside a `position:
 * relative` parent (the overlay's offsetParent). Built for the usage-queue
 * control, which otherwise parks over the terminal's bottom input line.
 *
 * Position model — deliberately two-state:
 *   - `null` (never dragged): the caller renders at a CSS default corner (e.g.
 *     `top: MARGIN; right: MARGIN`). No JS measurement, no clamp, and it tracks
 *     pane resize for free. This is the common case.
 *   - `{x, y}` (user dragged): an explicit left/top in offsetParent pixels,
 *     clamped inside the pane and RE-clamped on pane resize so it can never be
 *     lost off-canvas (the pane is `overflow-hidden`).
 *
 * Persistence: the `{x, y}` is written to localStorage under `storageKey`
 * (the caller keys it per session, so position is PER TERMINAL). Restored on
 * mount, survives the overlay hiding/re-showing.
 *
 * a11y: the handle is a focusable button; arrow keys nudge the overlay in
 * `STEP` px increments (also clamped + persisted), so it's repositionable
 * without a pointer.
 */

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Inset from the pane edge for the default corner AND the clamp gutter (px).
 *  Matches the old `right-3 bottom-3` (0.75rem). */
export const MARGIN = 12;
/** Arrow-key nudge distance (px). */
export const STEP = 12;

export interface Pos {
  x: number;
  y: number;
}

function loadPos(storageKey: string): Pos | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      // Number.isFinite already rejects non-numbers (and NaN/Infinity) without
      // coercion, so it subsumes a typeof check.
      const { x, y } = parsed as Pos;
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
  } catch {
    // Corrupt/blocked storage → fall back to the default corner.
  }
  return null;
}

function savePos(storageKey: string, pos: Pos): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(pos));
  } catch {
    // Storage full/blocked — position just won't persist; not worth surfacing.
  }
}

/** Clamp a desired position so the overlay stays fully inside its parent with a
 *  MARGIN gutter. If the parent is smaller than the overlay + gutters, pin to
 *  MARGIN (top-left) rather than producing a negative upper bound. */
function clampPos(desired: Pos, el: HTMLElement): Pos {
  const parent = el.offsetParent as HTMLElement | null;
  if (!parent) return desired;
  const maxX = Math.max(MARGIN, parent.clientWidth - el.offsetWidth - MARGIN);
  const maxY = Math.max(MARGIN, parent.clientHeight - el.offsetHeight - MARGIN);
  return {
    x: Math.min(Math.max(desired.x, MARGIN), maxX),
    y: Math.min(Math.max(desired.y, MARGIN), maxY),
  };
}

export interface DraggableOverlay {
  /** Attach to the overlay container (the positioned element being moved). A
   *  callback ref — the element mounts conditionally, and the observer effect
   *  needs to react to that mount. */
  overlayRef: React.RefCallback<HTMLDivElement>;
  /** Spread onto the overlay container's `style` — either the CSS default
   *  corner or the explicit dragged position. */
  positionStyle: CSSProperties;
  /** True while a pointer drag is in progress (for a `grabbing` cursor etc.). */
  dragging: boolean;
  /** Spread onto the drag HANDLE element (not the whole overlay). */
  handleProps: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onKeyDown: (e: KeyboardEvent) => void;
  };
}

/**
 * @param storageKey localStorage key for this overlay's position (caller keys
 *   it per session for per-terminal persistence).
 * @param defaultStyle CSS for the not-yet-dragged corner (e.g. `{ top, right }`).
 */
export function useDraggableOverlay(
  storageKey: string,
  defaultStyle: CSSProperties,
): DraggableOverlay {
  // Callback ref (not useRef): the overlay is CONDITIONALLY rendered — the
  // consumer returns null until it's `capped`, so the positioned element mounts
  // LATER than this hook. A one-shot mount effect would wire the ResizeObserver
  // against a still-null ref and, with [] deps, never re-run once the element
  // appears. Publishing the node as STATE lets the observer effect below fire
  // when the element actually mounts, and re-fire on a hide→show remount.
  // `elRef` keeps a synchronous handle for the pointer handlers.
  const elRef = useRef<HTMLDivElement | null>(null);
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const overlayRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    setOverlayEl(el);
  }, []);
  const [pos, setPos] = useState<Pos | null>(() => loadPos(storageKey));
  const [dragging, setDragging] = useState(false);

  // Mutable drag session state — kept in a ref so pointermove doesn't re-render
  // beyond the setPos it already triggers.
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  // Fires when the overlay element actually mounts (overlayEl becomes non-null)
  // and re-fires on a hide→show remount. Two jobs:
  //  1. Clamp-on-mount — a position saved when the pane was larger must be
  //     pulled back into the current pane immediately, not only on a later
  //     resize; otherwise a restore into a smaller pane strands it off-canvas.
  //  2. Re-clamp on every pane resize so an explicit position can't end up
  //     off-canvas (the pane is overflow-hidden).
  useEffect(() => {
    const el = overlayEl;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || typeof ResizeObserver === "undefined") return;
    setPos((p) => (p ? clampPos(p, el) : p));
    const ro = new ResizeObserver(() => {
      setPos((p) => (p ? clampPos(p, el) : p));
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [overlayEl]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const el = elRef.current;
    if (!el) return;
    // Start from wherever the overlay currently renders — for a never-dragged
    // overlay that's the CSS default corner (offsetLeft/Top read it back).
    drag.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startX: el.offsetLeft,
      startY: el.offsetTop,
    };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not all environments implement pointer capture (jsdom); the drag still
      // works via the move/up handlers, capture just keeps it robust if the
      // pointer leaves the handle.
    }
    e.preventDefault();
    // preventDefault suppresses the implicit focus a pointerdown would give the
    // handle — without this, arrow-key nudge wouldn't work right after a drag
    // (you'd have to Tab to the handle first). Focus it explicitly.
    (e.currentTarget as HTMLElement).focus();
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const el = elRef.current;
    const d = drag.current;
    if (!el || !d) return;
    const desired = {
      x: d.startX + (e.clientX - d.pointerX),
      y: d.startY + (e.clientY - d.pointerY),
    };
    setPos(clampPos(desired, el));
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be gone
      }
      setPos((p) => {
        if (p) savePos(storageKey, p);
        return p;
      });
    },
    [storageKey],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const delta =
        e.key === "ArrowLeft"
          ? { x: -STEP, y: 0 }
          : e.key === "ArrowRight"
            ? { x: STEP, y: 0 }
            : e.key === "ArrowUp"
              ? { x: 0, y: -STEP }
              : e.key === "ArrowDown"
                ? { x: 0, y: STEP }
                : null;
      if (!delta) return;
      const el = elRef.current;
      if (!el) return;
      e.preventDefault();
      const base: Pos = pos ?? { x: el.offsetLeft, y: el.offsetTop };
      const next = clampPos({ x: base.x + delta.x, y: base.y + delta.y }, el);
      setPos(next);
      savePos(storageKey, next);
    },
    [pos, storageKey],
  );

  return {
    overlayRef,
    positionStyle: pos ? { left: pos.x, top: pos.y } : defaultStyle,
    dragging,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onKeyDown },
  };
}
