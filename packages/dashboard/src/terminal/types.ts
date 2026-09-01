/**
 * Terminal Backend Types
 *
 * Defines the interface contract the xterm.js backend satisfies, built from
 * the exact set of members that terminal/liveTerminals.ts uses.
 */

export interface IDisposable {
  dispose(): void;
}

export type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

export interface IBufferLine {
  readonly length: number;
  translateToString(trimRight?: boolean): string;
}

export interface IBuffer {
  readonly baseY: number;
  readonly viewportY: number;
  getLine(y: number): IBufferLine | undefined;
}

export interface IBufferNamespace {
  readonly active: IBuffer;
}

export interface ILinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface ILink {
  range: ILinkRange;
  text: string;
  activate(event: MouseEvent, text?: string): void;
}

export interface ILinkProvider {
  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void;
}

export interface TerminalOptions {
  cursorBlink?: boolean;
  fontSize?: number;
  fontFamily?: string;
  theme?: Record<string, string>;
  scrollback?: number;
}

/**
 * The terminal instance interface — the exact surface that liveTerminals.ts uses.
 * xterm.js Terminal satisfies this structurally.
 */
export interface TerminalInstance {
  open(parent: HTMLElement): void;
  dispose(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  focus(): void;
  readonly cols: number;
  readonly rows: number;
  readonly textarea?: HTMLTextAreaElement;
  readonly buffer: IBufferNamespace;
  readonly unicode: { activeVersion: string };
  options: {
    fontSize?: number;
    lineHeight?: number;
    theme?: Record<string, string>;
  };
  scrollLines(amount: number): void;
  scrollToBottom(): void;
  selectAll(): void;
  clear(): void;
  reset(): void;
  refresh(start: number, end: number): void;
  readonly onData: IEvent<string>;
  readonly onScroll: IEvent<number>;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  readonly parser: {
    registerCsiHandler(
      id: { final: string; prefix?: string; intermediates?: string },
      handler: (params: (number | number[])[]) => boolean,
    ): IDisposable;
  };
  registerLinkProvider(provider: ILinkProvider): void;
  loadAddon(addon: ITerminalAddon): void;
}

export interface ITerminalAddon {
  dispose(): void;
}

export interface IFitAddon extends ITerminalAddon {
  fit(): void;
}

export interface IWebglAddon extends ITerminalAddon {
  /**
   * Fires when the GPU drops the addon's WebGL context. The renderer stops
   * painting until the addon is disposed and recreated, so callers MUST
   * listen and reload — otherwise typed input appears to hang.
   */
  onContextLoss(listener: () => void): { dispose(): void };
}

export interface TerminalBackend {
  terminal: TerminalInstance;
  fitAddon: IFitAddon;
  /** Create a WebGL addon for GPU rendering. Returns null if unavailable. */
  createWebglAddon(): IWebglAddon | null;
}
