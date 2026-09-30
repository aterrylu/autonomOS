import { useRef } from "react";
import type { RollupBucket } from "./teams";
import type { OrgChartTokens } from "./theme";
import {
  type CanvasViewApi,
  type CanvasViewStore,
  useCanvasViewSnapshot,
} from "./useCanvasView";
import {
  fitsInView,
  mapFrame,
  type Size,
  viewFromMapPoint,
  viewportOnMap,
} from "./viewport";

const MAP_W = 188;
const MAP_H = 118;

export interface MapCard {
  id: string;
  x: number;
  y: number;
  bucket: RollupBucket;
  selected: boolean;
}

/**
 * The bottom-right map (PR 5, pick 2A): every card in its status color and the
 * outline of what's on screen. Shown only when the chart doesn't fit — a map of
 * a fully visible chart is noise. Click or drag it to move the view.
 */
export function Minimap({
  cards,
  cardSize,
  content,
  tokens,
  store,
  api,
}: {
  cards: MapCard[];
  cardSize: Size;
  content: Size;
  tokens: OrgChartTokens;
  store: CanvasViewStore;
  api: CanvasViewApi;
}) {
  const { view, viewport } = useCanvasViewSnapshot(store);
  const dragging = useRef(false);
  if (viewport.w === 0 || fitsInView(view, content, viewport)) return null;
  const f = mapFrame(content, { w: MAP_W, h: MAP_H });
  const box = viewportOnMap(view, viewport, f);
  const color = (b: RollupBucket) =>
    b === "needsYou"
      ? tokens.status.needsInput
      : b === "working"
        ? tokens.status.active
        : b === "error"
          ? tokens.status.error
          : b === "idle"
            ? tokens.status.ready
            : tokens.status.neutral;
  const moveTo = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    api.set(
      viewFromMapPoint(
        view,
        viewport,
        f,
        e.clientX - r.left,
        e.clientY - r.top,
      ),
    );
  };
  return (
    <div
      data-org-minimap
      className="absolute right-2.5 bottom-2.5 z-[4] overflow-hidden rounded-lg"
      style={{
        border: `1px solid ${tokens.cardBorder}`,
        background: tokens.isLight ? "#ffffffe6" : "#0c0e11e6",
        boxShadow: tokens.cardShadow,
      }}
    >
      <svg
        role="img"
        aria-label={`Map of ${cards.length} agents; the outline is what's on screen. Click to move there.`}
        width={MAP_W}
        height={MAP_H}
        className="block cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.stopPropagation();
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) moveTo(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {cards.map((c) => (
          <rect
            key={c.id}
            data-org-minimap-card={c.id}
            x={f.ox + c.x * f.s}
            y={f.oy + c.y * f.s}
            width={Math.max(2, cardSize.w * f.s)}
            height={Math.max(2, cardSize.h * f.s)}
            rx={1}
            fill={color(c.bucket)}
            opacity={c.bucket === "exited" ? 0.35 : c.selected ? 1 : 0.8}
          />
        ))}
        <rect
          data-org-minimap-view
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={2}
          fill="none"
          stroke={tokens.status.active}
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}

/** − 100% + Fit, for the chart toolbar. */
export function ZoomControls({
  store,
  api,
  tokens,
}: {
  store: CanvasViewStore;
  api: CanvasViewApi;
  tokens: OrgChartTokens;
}) {
  const { view } = useCanvasViewSnapshot(store);
  const btn = "cursor-pointer rounded px-2 py-0.5";
  const style = { color: tokens.fg, border: `1px solid ${tokens.cardBorder}` };
  return (
    <fieldset
      data-org-zoom
      className="m-0 flex items-center gap-1 border-0 p-0"
    >
      <legend className="sr-only">Zoom</legend>
      <button
        type="button"
        aria-label="Zoom out"
        className={btn}
        style={style}
        onClick={() => api.zoomBy(0.8)}
      >
        −
      </button>
      <button
        type="button"
        data-org-zoom-pct
        title="Back to 100%"
        className="cursor-pointer rounded px-1.5 py-0.5 tabular-nums"
        style={{ color: tokens.fg, minWidth: 44 }}
        onClick={api.reset}
      >
        {Math.round(view.k * 100)}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        className={btn}
        style={style}
        onClick={() => api.zoomBy(1.25)}
      >
        +
      </button>
      <button
        type="button"
        data-org-zoom-fit
        className={btn}
        style={style}
        onClick={api.fit}
      >
        Fit
      </button>
    </fieldset>
  );
}
