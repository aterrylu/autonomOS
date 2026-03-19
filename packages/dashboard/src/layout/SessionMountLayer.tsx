import { useEffect, useRef, useState } from "react";
import { PreviewPane } from "../components/PreviewPane";
import { SessionPane } from "../components/SessionPane";
import { useStore } from "../store";
import { allLeafIds, findLeaf } from "./layoutTree";
import { type SlotRect, useLayoutContext } from "./LayoutContext";

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
  const { getAllSlots } = useLayoutContext();

  // Force re-render when slots update (via ResizeObserver in PaneSlot)
  const [, setTick] = useState(0);
  const triggerUpdate = () => setTick((t) => t + 1);

  // Expose triggerUpdate so PaneSlot can call it after registering rects
  useSlotUpdateTrigger(triggerUpdate);

  // Also re-render on window resize (sidebar toggle, viewport change)
  useEffect(() => {
    window.addEventListener("resize", triggerUpdate);
    return () => window.removeEventListener("resize", triggerUpdate);
  }, []);

  const slots = getAllSlots();

  // Build a map from ActivePane id → slot rect by iterating all leaves
  const paneToRect = new Map<string, SlotRect>();
  for (const leafId of allLeafIds(layout)) {
    const leaf = findLeaf(layout, leafId);
    if (!leaf?.pane) continue;
    const rect = slots.get(leafId);
    if (rect) {
      paneToRect.set(leaf.pane.id, rect);
    }
  }

  // Determine focused pane for z-index stacking
  const focusedLeaf = findLeaf(layout, focusedLeafId);
  const focusedPaneId = focusedLeaf?.pane?.id;

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
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    zIndex: s.id === focusedPaneId ? 2 : 1,
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
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    zIndex: p.id === focusedPaneId ? 2 : 1,
                  }
                : { display: "none" }
            }
          >
            <PreviewPane preview={p} visible={true} />
          </div>
        );
      })}
    </>
  );
}

// ── Slot update trigger registry ──────────────────────────────────────────

/** Global registry so PaneSlot can call triggerUpdate after registering. */
let _slotUpdateCallback: (() => void) | null = null;

export function notifySlotUpdate() {
  _slotUpdateCallback?.();
}

function useSlotUpdateTrigger(cb: () => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    _slotUpdateCallback = () => cbRef.current();
    return () => {
      _slotUpdateCallback = null;
    };
  }, []);
}
