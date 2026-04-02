import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";
import { DropZoneOverlay } from "./DropZoneOverlay";
import { useLayoutContext } from "./LayoutContext";
import { allLeafIds, findLeaf } from "./layoutTree";
import { notifySlotUpdate } from "./SessionMountLayer";
import { TAB_HEIGHT, TabBar } from "./TabBar";

interface PaneSlotProps {
  leafId: string;
  /** Whether this leaf is the currently focused pane. */
  focused: boolean;
}

/**
 * PaneSlot — renders the chrome for a single leaf slot:
 * - Tab bar (auto-hides for single tab)
 * - Registers its bounding rect (offset by tab bar) for SessionMountLayer
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

  const leaf = findLeaf(layout, leafId);
  const leafCount = allLeafIds(layout).length;
  const hasTabs = (leaf?.tabs.length ?? 0) > 1;

  // Register slot rect + keep it updated via ResizeObserver.
  // When tabs are visible, offset the top by TAB_HEIGHT so the terminal
  // renders below the tab bar.
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;

    function updateRect() {
      if (!el) return;
      let container: HTMLElement | null = el.parentElement;
      while (container && getComputedStyle(container).position === "static") {
        container = container.parentElement;
      }
      const containerRect = container
        ? container.getBoundingClientRect()
        : { left: 0, top: 0 };
      const rect = el.getBoundingClientRect();
      // Offset top by tab bar height when tabs are visible
      const tabOffset = hasTabs ? TAB_HEIGHT : 0;
      registerSlot(leafId, {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top + tabOffset,
        width: rect.width,
        height: rect.height - tabOffset,
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
  }, [leafId, registerSlot, unregisterSlot, hasTabs]);

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
      {/* Tab bar — auto-hides for single tab */}
      {leaf && hasTabs && (
        <TabBar
          leafId={leafId}
          tabs={leaf.tabs}
          activeTabIndex={leaf.activeTabIndex}
        />
      )}

      {/* Close button — shown when multiple panes */}
      {leafCount > 1 && (
        <button
          type="button"
          className="absolute right-1 z-30 flex items-center justify-center w-5 h-5 rounded text-xs cursor-pointer opacity-0 hover:opacity-100 transition-opacity focus:opacity-100"
          style={{
            background: page.border,
            color: page.statusFg,
            top: hasTabs ? TAB_HEIGHT + 4 : 4,
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
