import { useState } from "react";
import { useStore } from "../store";
import { DRAG_TYPE, decodeDragData, useDragContext } from "./DragContext";

type DropZone = "north" | "south" | "east" | "west" | "center";

interface DropZoneOverlayProps {
  leafId: string;
}

/**
 * DropZoneOverlay — shown on every PaneSlot during a sidebar drag.
 * Five zones: center (replace), N/S (horizontal split), E/W (vertical split).
 */
export function DropZoneOverlay({ leafId }: DropZoneOverlayProps) {
  const { isDragging, dragData, endDrag } = useDragContext();
  const [hoveredZone, setHoveredZone] = useState<DropZone | null>(null);
  const splitLeafWithPane = useStore((s) => s.splitLeafWithPane);
  const setLeafPane = useStore((s) => s.setLeafPane);

  if (!isDragging) return null;

  function handleDrop(zone: DropZone) {
    if (!dragData) return;
    const { pane } = dragData;
    switch (zone) {
      case "center":
        setLeafPane(leafId, pane);
        break;
      case "north":
        splitLeafWithPane(leafId, "horizontal", "first", pane);
        break;
      case "south":
        splitLeafWithPane(leafId, "horizontal", "second", pane);
        break;
      case "west":
        splitLeafWithPane(leafId, "vertical", "first", pane);
        break;
      case "east":
        splitLeafWithPane(leafId, "vertical", "second", pane);
        break;
    }
    endDrag();
  }

  function zoneStyle(zone: DropZone): React.CSSProperties {
    const base: React.CSSProperties = {
      position: "absolute",
      zIndex: 20,
      transition: "background 0.1s",
      background:
        hoveredZone === zone
          ? "rgba(83, 189, 250, 0.35)"
          : "rgba(83, 189, 250, 0.08)",
    };
    switch (zone) {
      case "north":
        return { ...base, top: 0, left: "25%", right: "25%", height: "25%" };
      case "south":
        return { ...base, bottom: 0, left: "25%", right: "25%", height: "25%" };
      case "west":
        return { ...base, left: 0, top: "25%", bottom: "25%", width: "25%" };
      case "east":
        return { ...base, right: 0, top: "25%", bottom: "25%", width: "25%" };
      case "center":
        return {
          ...base,
          top: "25%",
          left: "25%",
          right: "25%",
          bottom: "25%",
        };
    }
  }

  const zones: DropZone[] = ["north", "south", "west", "east", "center"];

  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      {zones.map((zone) => (
        <div
          key={zone}
          style={{ ...zoneStyle(zone), pointerEvents: "all" }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setHoveredZone(zone);
          }}
          onDragLeave={() => setHoveredZone(null)}
          onDrop={(e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData(DRAG_TYPE);
            const data = raw ? decodeDragData(raw) : dragData;
            if (data) {
              handleDrop(zone);
            }
            setHoveredZone(null);
          }}
        />
      ))}
    </div>
  );
}
