import { useEffect, useRef, useState } from "react";
import { HierarchyPanel } from "../components/HierarchyPanel";
import { PreviewPane } from "../components/PreviewPane";
import { SessionPane } from "../components/SessionPane";
import { TemplatesPanel } from "../components/TemplatesPanel";
import { useStore } from "../store";
import { useDragContext } from "./DragContext";
import { type SlotRect, useLayoutContext } from "./LayoutContext";
import { activeTabPane, allLeafIds, findLeaf } from "./layoutTree";

/**
 * SessionMountLayer — mounts ALL sessions and previews once at the app root,
 * absolutely positioned to match their assigned pane slot rect.
 *
 * This preserves xterm.js instances across layout changes (splits, resizes).
 * Each pane is kept alive as long as the session/preview exists, regardless
 * of how many leaves are visible.
 */
export function SessionMountLayer() {
  const sessions = useStore((s) => s.sessions);
  const previewPanes = useStore((s) => s.previewPanes);
  const layout = useStore((s) => s.layout);
  const focusedLeafId = useStore((s) => s.focusedLeafId);
  const { isDragging } = useDragContext();
  const { getAllSlots } = useLayoutContext();

  // Force re-render when slots update (via ResizeObserver in PaneSlot)
  const [, setTick] = useState(0);
  const triggerUpdate = () => setTick((t) => t + 1);

  // Expose triggerUpdate so PaneSlot can call it after registering rects
  useSlotUpdateTrigger(triggerUpdate);

  // Also re-render on window resize (sidebar toggle, viewport change)
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggerUpdate is stable (only calls setTick)
  useEffect(() => {
    window.addEventListener("resize", triggerUpdate);
    return () => window.removeEventListener("resize", triggerUpdate);
  }, []);

  const slots = getAllSlots();

  // Build a map from ActivePane id → slot rect by iterating all leaves.
  // Only the active tab in each leaf gets a rect — other tabs stay hidden.
  const paneToRect = new Map<string, SlotRect>();
  for (const leafId of allLeafIds(layout)) {
    const leaf = findLeaf(layout, leafId);
    if (!leaf) continue;
    const activePaneForLeaf = activeTabPane(leaf);
    if (!activePaneForLeaf) continue;
    const rect = slots.get(leafId);
    if (rect) {
      paneToRect.set(activePaneForLeaf.id, rect);
    }
  }

  // Determine focused pane for z-index stacking
  const focusedLeaf = findLeaf(layout, focusedLeafId);
  const focusedPaneId = focusedLeaf
    ? activeTabPane(focusedLeaf)?.id
    : undefined;

  const orgChartRect = paneToRect.get("orgchart");
  const templatesRect = paneToRect.get("templates");

  return (
    <>
      {sessions.map((s) => {
        const rect = paneToRect.get(s.id);
        return (
          <div
            key={s.id}
            style={
              rect
                ? {
                    position: "absolute",
                    display: "flex",
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    zIndex: s.id === focusedPaneId ? 2 : 1,
                    // Disable pointer events during drag so DropZoneOverlay receives events
                    pointerEvents: isDragging ? "none" : "auto",
                  }
                : { display: "none" }
            }
          >
            <SessionPane sessionId={s.id} visible={true} />
          </div>
        );
      })}
      {previewPanes.map((p) => {
        const rect = paneToRect.get(p.id);
        return (
          <div
            key={p.id}
            style={
              rect
                ? {
                    position: "absolute",
                    display: "flex",
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    zIndex: p.id === focusedPaneId ? 2 : 1,
                    pointerEvents: isDragging ? "none" : "auto",
                  }
                : { display: "none" }
            }
          >
            <PreviewPane preview={p} visible={true} />
          </div>
        );
      })}
      {/* Singleton panes (orgchart, templates) */}
      <SingletonPane
        paneId="orgchart"
        rect={orgChartRect}
        focusedPaneId={focusedPaneId}
        isDragging={isDragging}
      >
        <HierarchyPanel />
      </SingletonPane>
      <SingletonPane
        paneId="templates"
        rect={templatesRect}
        focusedPaneId={focusedPaneId}
        isDragging={isDragging}
      >
        <TemplatesPanel />
      </SingletonPane>
    </>
  );
}

/** Wrapper for singleton panes (orgchart, templates) — absolute positioned to slot rect */
function SingletonPane({
  paneId,
  rect,
  focusedPaneId,
  isDragging,
  children,
}: {
  paneId: string;
  rect: SlotRect | undefined;
  focusedPaneId: string | undefined;
  isDragging: boolean;
  children: React.ReactNode;
}) {
  if (!rect) return null;
  return (
    <div
      style={{
        position: "absolute",
        display: "flex",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: focusedPaneId === paneId ? 2 : 1,
        pointerEvents: isDragging ? "none" : "auto",
      }}
    >
      {children}
    </div>
  );
}

// ── Slot update trigger registry ──────────────────────────────────────────

/** Global registry so PaneSlot can call triggerUpdate after registering. */
let _slotUpdateCallback: (() => void) | null = null;
let _rafId: number | null = null;

/** Batched slot update — coalesces multiple calls per frame via rAF */
export function notifySlotUpdate() {
  if (_rafId !== null) return; // already scheduled
  _rafId = requestAnimationFrame(() => {
    _rafId = null;
    _slotUpdateCallback?.();
  });
}

function useSlotUpdateTrigger(cb: () => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    _slotUpdateCallback = () => cbRef.current();
    return () => {
      _slotUpdateCallback = null;
      if (_rafId !== null) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
      }
    };
  }, []);
}
