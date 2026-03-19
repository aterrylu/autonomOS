import { createContext, useCallback, useContext, useRef } from "react";

/**
 * LayoutContext — shared registry for pane slot bounding rects.
 *
 * PaneSlot writes its rect here via registerSlot().
 * SessionMountLayer reads all slot rects to absolutely position sessions.
 */

export interface SlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LayoutContextValue {
  /** Register or update the bounding rect of a leaf slot. */
  registerSlot: (leafId: string, rect: SlotRect) => void;
  /** Remove a leaf slot (called on PaneSlot unmount so stale rects don't linger). */
  unregisterSlot: (leafId: string) => void;
  /** Get the current rect for a leaf slot (may be undefined if not yet registered). */
  getSlotRect: (leafId: string) => SlotRect | undefined;
  /** Get a snapshot of all registered slots (for SessionMountLayer). */
  getAllSlots: () => ReadonlyMap<string, SlotRect>;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const slotsRef = useRef<Map<string, SlotRect>>(new Map());

  const registerSlot = useCallback((leafId: string, rect: SlotRect) => {
    slotsRef.current.set(leafId, rect);
  }, []);

  const unregisterSlot = useCallback((leafId: string) => {
    slotsRef.current.delete(leafId);
  }, []);

  const getSlotRect = useCallback((leafId: string) => {
    return slotsRef.current.get(leafId);
  }, []);

  const getAllSlots = useCallback(() => {
    return slotsRef.current as ReadonlyMap<string, SlotRect>;
  }, []);

  return (
    <LayoutContext.Provider
      value={{ registerSlot, unregisterSlot, getSlotRect, getAllSlots }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayoutContext(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayoutContext must be inside LayoutProvider");
  return ctx;
}
