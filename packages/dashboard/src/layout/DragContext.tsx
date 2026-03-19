import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ActivePane } from "../store";

/**
 * DragContext — tracks the active sidebar drag state at the app level.
 *
 * Sidebar sets drag data via dataTransfer and calls startDrag/endDrag.
 * DropZoneOverlay reads isDragging to show/hide the overlay.
 * On drop, the drop zone calls handleDrop with the drag data.
 */

export interface DragData {
  pane: ActivePane;
}

interface DragContextValue {
  isDragging: boolean;
  dragData: DragData | null;
  startDrag: (data: DragData) => void;
  endDrag: () => void;
}

const DragContext = createContext<DragContextValue | null>(null);

export function DragProvider({ children }: { children: React.ReactNode }) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragData, setDragData] = useState<DragData | null>(null);

  const startDrag = useCallback((data: DragData) => {
    setDragData(data);
    setIsDragging(true);
  }, []);

  const endDrag = useCallback(() => {
    setIsDragging(false);
    setDragData(null);
  }, []);

  // Clean up if drag ends outside (e.g., user releases outside a drop zone)
  useEffect(() => {
    const handleDragEnd = () => endDrag();
    document.addEventListener("dragend", handleDragEnd);
    return () => document.removeEventListener("dragend", handleDragEnd);
  }, [endDrag]);

  return (
    <DragContext.Provider value={{ isDragging, dragData, startDrag, endDrag }}>
      {children}
    </DragContext.Provider>
  );
}

export function useDragContext(): DragContextValue {
  const ctx = useContext(DragContext);
  if (!ctx) throw new Error("useDragContext must be inside DragProvider");
  return ctx;
}

// ── Drag data serialization ───────────────────────────────────────────────

export const DRAG_TYPE = "application/autonomos-pane";

export function encodeDragData(data: DragData): string {
  return JSON.stringify(data);
}

export function decodeDragData(raw: string): DragData | null {
  try {
    return JSON.parse(raw) as DragData;
  } catch {
    return null;
  }
}
