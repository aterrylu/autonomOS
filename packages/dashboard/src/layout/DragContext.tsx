import type { ActivePane } from "../store";

/**
 * Sidebar drag payload + serialization helpers.
 *
 * A sidebar item carries its pane through an HTML5 drag via dataTransfer; the
 * dockview drop handler decodes it to compose a tab/split. Only the data shape
 * and (de)serialization live here — there is no React drag state anymore.
 */

export interface DragData {
  pane: ActivePane;
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
