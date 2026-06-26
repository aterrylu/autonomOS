// A controllable fake PTY for performance benchmarking.
//
// Implements just enough of node-pty's `IPty` surface that the real terminal
// transport code (`routes/terminal.ts`) and the output-buffer code
// (`agents/runtime.ts`) treat it as a genuine PTY. The harness drives output by
// calling `emit()` / `emitBurst()` directly, which fans out to every registered
// `onData` listener exactly as a real PTY's event emitter does — so a real
// `ws.send()` fires per chunk on `main`, and the (flagged) coalescer batches
// them. Deterministic: no timers, no OS scheduling — the harness controls
// exactly when each chunk lands.

import type { IDisposable, IPty } from "node-pty";

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;

export class FakePty {
  readonly pid = 999999;
  cols = 120;
  rows = 40;
  readonly process = "fake-perf-pty";
  handleFlowControl = false;

  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();

  /** Mirrors node-pty's `onData: IEvent<string>`. Multiple listeners allowed. */
  onData = (listener: DataListener): IDisposable => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  onExit = (listener: ExitListener): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  /** node-pty also exposes a deprecated `on()`; stubbed for type-compat. */
  on = (): void => {};

  resize = (cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
  };

  clear = (): void => {};
  write = (_data: string): void => {};
  pause = (): void => {};
  resume = (): void => {};

  kill = (): void => {
    for (const l of this.exitListeners) l({ exitCode: 0 });
  };

  // ── Harness drive API ────────────────────────────────────────────────
  /** Fire one chunk to every data listener (one PTY "onData" event). */
  emit(chunk: string): void {
    for (const l of this.dataListeners) l(chunk);
  }

  /** Fire an ordered burst, chunk by chunk. */
  emitBurst(chunks: string[]): void {
    for (const c of chunks) this.emit(c);
  }

  /** How many data listeners are attached (e.g. runtime buffer + N clients). */
  get listenerCount(): number {
    return this.dataListeners.size;
  }

  asIPty(): IPty {
    return this as unknown as IPty;
  }
}
