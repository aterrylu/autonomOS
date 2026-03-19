import { useRef, useState } from "react";
import { useStore } from "../store";
import { findLeafByPaneId } from "./layoutTree";
import { useDragContext } from "./DragContext";

type SplitZone = "north" | "south" | "east" | "west" | "center";

interface DropZoneOverlayProps {
  leafId: string;
}

/**
 * DropZoneOverlay — ghost split preview shown during sidebar drag.
 *
 * Tracks cursor position to determine split direction. Renders a translucent
 * preview of where the new terminal will sit.
 *
 * If dragging an existing pane (already in the layout), performs a MOVE
 * instead of a split — removes the pane from its old position.
 */
export function DropZoneOverlay({ leafId }: DropZoneOverlayProps) {
  const { isDragging, dragData, endDrag } = useDragContext();
  const [zone, setZone] = useState<SplitZone | null>(null);
  const splitLeafWithPane = useStore((s) => s.splitLeafWithPane);
  const setLeafPane = useStore((s) => s.setLeafPane);
  const movePaneToLeaf = useStore((s) => s.movePaneToLeaf);
  const layout = useStore((s) => s.layout);
  const containerRef = useRef<HTMLDivElement>(null);

  if (!isDragging) return null;

  // Check if the dragged pane is already in the layout (= move, not split)
  const isExistingPane = dragData?.pane
    ? !!findLeafByPaneId(layout, dragData.pane.id)
    : false;

  function detectZone(e: React.DragEvent): SplitZone {
    const el = containerRef.current;
    if (!el) return "center";
    const rect = el.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;

    if (relX < 0.25) return "west";
    if (relX > 0.75) return "east";
    if (relY < 0.25) return "north";
    if (relY > 0.75) return "south";
    return "center";
  }

  function handleDrop(z: SplitZone) {
    if (!dragData) return;
    const { pane } = dragData;

    if (isExistingPane) {
      // Move existing pane — removes from old position, places in new
      movePaneToLeaf(pane.id, leafId, z);
    } else {
      // New pane — split or replace
      switch (z) {
        case "center":
          setLeafPane(leafId, pane);
          break;
        case "north":
          splitLeafWithPane(leafId, "vertical", "first", pane);
          break;
        case "south":
          splitLeafWithPane(leafId, "vertical", "second", pane);
          break;
        case "west":
          splitLeafWithPane(leafId, "horizontal", "first", pane);
          break;
        case "east":
          splitLeafWithPane(leafId, "horizontal", "second", pane);
          break;
      }
    }
    endDrag();
  }

  // Ghost preview styles based on detected zone
  function ghostStyle(): React.CSSProperties | null {
    if (!zone || zone === "center") return null;
    const base: React.CSSProperties = {
      position: "absolute",
      background: "rgba(83, 189, 250, 0.12)",
      border: "2px solid rgba(83, 189, 250, 0.6)",
      pointerEvents: "none",
      transition: "all 0.15s ease",
    };
    switch (zone) {
      case "north":
        return { ...base, top: 0, left: 0, right: 0, height: "50%", borderBottom: "2px solid rgba(83, 189, 250, 0.8)" };
      case "south":
        return { ...base, bottom: 0, left: 0, right: 0, height: "50%", borderTop: "2px solid rgba(83, 189, 250, 0.8)" };
      case "west":
        return { ...base, top: 0, left: 0, bottom: 0, width: "50%", borderRight: "2px solid rgba(83, 189, 250, 0.8)" };
      case "east":
        return { ...base, top: 0, right: 0, bottom: 0, width: "50%", borderLeft: "2px solid rgba(83, 189, 250, 0.8)" };
    }
  }

  function centerStyle(): React.CSSProperties | null {
    if (zone !== "center") return null;
    return {
      position: "absolute",
      inset: 0,
      background: "rgba(83, 189, 250, 0.15)",
      border: "2px solid rgba(83, 189, 250, 0.5)",
      pointerEvents: "none",
    };
  }

  const ghost = ghostStyle();
  const center = centerStyle();

  // Label: "Move" for existing panes, "Split" / "Replace" for new
  function dropLabel(): string | null {
    if (!zone) return null;
    if (zone === "center") return "Replace";
    return isExistingPane ? "Move" : "Split";
  }
  const label = dropLabel();

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setZone(detectZone(e));
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        e.preventDefault();
        if (zone) handleDrop(zone);
        setZone(null);
      }}
    >
      {ghost && <div style={ghost} />}
      {center && <div style={center} />}
      {label && (
        <div
          className="absolute text-[10px] font-medium px-1.5 py-0.5 rounded pointer-events-none"
          style={{
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(83, 189, 250, 0.9)",
            color: "#0a0e14",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
