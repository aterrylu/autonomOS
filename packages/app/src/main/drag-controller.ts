// Manual window-drag state machine, extracted from window-manager.ts so it
// can be unit-tested WITHOUT loading `electron` (same precedent as
// ephemeral-cleanup.ts). The OS-level pieces — cursor position, the window's
// position setter, and the timer — are injected, so a test can drive a drag
// frame-by-frame deterministically and prove the interval is always cleaned
// up (failure-class #7: leaked resources).

/** The narrow window surface a drag needs. Real BrowserWindow satisfies it. */
export interface DraggableWindow {
  readonly id: number;
  getPosition(): number[];
  setPosition(x: number, y: number, animate?: boolean): void;
  isDestroyed(): boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface DragDeps {
  /** Current cursor position in screen coords (electron `screen`). */
  getCursor(): Point;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface DragState {
  offsetX: number;
  offsetY: number;
  handle: unknown;
}

const FRAME_MS = 8;

export class DragController {
  private readonly drags = new Map<number, DragState>();
  constructor(private readonly deps: DragDeps) {}

  /** Begin dragging `win`. Restarts cleanly if a drag is already active for
   *  this window id (no double-interval leak). Each tick repositions the
   *  window to keep the same cursor↔corner offset; a destroyed window ends
   *  its own drag. */
  start(win: DraggableWindow): void {
    this.end(win.id); // idempotent restart — never leak a prior interval

    const cursor = this.deps.getCursor();
    const pos = win.getPosition();
    const winX = pos[0] ?? 0;
    const winY = pos[1] ?? 0;
    const offsetX = cursor.x - winX;
    const offsetY = cursor.y - winY;

    const handle = this.deps.setInterval(() => {
      if (win.isDestroyed()) {
        this.end(win.id);
        return;
      }
      const c = this.deps.getCursor();
      win.setPosition(c.x - offsetX, c.y - offsetY, false);
    }, FRAME_MS);

    this.drags.set(win.id, { offsetX, offsetY, handle });
  }

  /** End the drag for a window id. No-op if none active. */
  end(winId: number): void {
    const state = this.drags.get(winId);
    if (!state) return;
    this.deps.clearInterval(state.handle);
    this.drags.delete(winId);
  }

  /** Clear every active drag (called on app quit to avoid leaked timers). */
  cleanupAll(): void {
    for (const state of this.drags.values()) {
      this.deps.clearInterval(state.handle);
    }
    this.drags.clear();
  }

  /** TEST/inspection helper: number of active drags. */
  activeCount(): number {
    return this.drags.size;
  }
}
