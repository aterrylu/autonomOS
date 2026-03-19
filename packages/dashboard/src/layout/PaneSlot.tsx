import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";
import { DropZoneOverlay } from "./DropZoneOverlay";
import { useLayoutContext } from "./LayoutContext";
import { allLeafIds } from "./layoutTree";
import { notifySlotUpdate } from "./SessionMountLayer";

interface PaneSlotProps {
  leafId: string;
  /** Whether this leaf is the currently focused pane. */
  focused: boolean;
}

/**
 * PaneSlot — renders the chrome for a single leaf slot:
 * - Registers its bounding rect so SessionMountLayer can position sessions here
 * - Shows a focus ring when focused
 * - Renders drop zones during sidebar drags
 * - Renders a close button (when there are multiple panes)
 */
export function PaneSlot({ leafId, focused }: PaneSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { registerSlot, unregisterSlot } = useLayoutContext();
  const layout = useStore((s) => s.layout);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const setFocusedLeaf = useStore((s) => s.setFocusedLeaf);
  const closeLeaf = useStore((s) => s.closeLeaf);

  // Determine if we have multiple leaves (show close button)
  const leafCount = allLeafIds(layout).length;

  // Register slot rect + keep it updated via ResizeObserver.
  // Coords are relative to the App-level "relative flex flex-1 overflow-hidden" div
  // (the same ancestor that SessionMountLayer's absolute children are positioned within).
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;

    function updateRect() {
      if (!el) return;
      // Walk up to find the containing "relative" panel area
      let container: HTMLElement | null = el.parentElement;
      while (container && getComputedStyle(container).position === "static") {
        container = container.parentElement;
      }
      const containerRect = container
        ? container.getBoundingClientRect()
        : { left: 0, top: 0 };
      const rect = el.getBoundingClientRect();
      registerSlot(leafId, {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
        width: rect.width,
        height: rect.height,
      });
      notifySlotUpdate();
    }

    updateRect();
    const ro = new ResizeObserver(updateRect);
    ro.observe(el);
    return () => {
      ro.disconnect();
      unregisterSlot(leafId);
      notifySlotUpdate();
    };
  }, [leafId, registerSlot, unregisterSlot]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane focus on click
    // biome-ignore lint/a11y/useKeyWithClickEvents: pane focus on click
    <div
      ref={slotRef}
      className="relative flex-1 h-full"
      style={{
        outline: focused ? `2px solid ${page.border}` : "none",
        outlineOffset: "-2px",
      }}
      onClick={() => setFocusedLeaf(leafId)}
    >
      {/* Close button — shown when multiple panes */}
      {leafCount > 1 && (
        <button
          type="button"
          className="absolute top-1 right-1 z-30 flex items-center justify-center w-5 h-5 rounded text-xs cursor-pointer opacity-0 hover:opacity-100 transition-opacity focus:opacity-100"
          style={{
            background: page.border,
            color: page.statusFg,
          }}
          onClick={(e) => {
            e.stopPropagation();
            closeLeaf(leafId);
          }}
          title="Close pane (Ctrl+W)"
        >
          ✕
        </button>
      )}

      {/* Drop zones — shown during sidebar drag */}
      <DropZoneOverlay leafId={leafId} />
    </div>
  );
}
