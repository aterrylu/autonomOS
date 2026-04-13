/**
 * Terminal Backend Types
 *
 * Defines the interface contract that both xterm.js and ghostty-web
 * must satisfy. Built from the exact set of members that useTerminal.ts uses.
 */

export type TerminalRenderer = "xterm" | "ghostty-web";

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
 * The terminal instance interface — the exact surface that useTerminal.ts uses.
 * Both xterm.js Terminal and ghostty-web Terminal satisfy this structurally.
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
  readonly onData: IEvent<string>;
  readonly onScroll: IEvent<number>;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  registerLinkProvider(provider: ILinkProvider): void;
  loadAddon(addon: ITerminalAddon): void;
}

export interface ITerminalAddon {
  dispose(): void;
}

export interface IFitAddon extends ITerminalAddon {
  fit(): void;
}

export interface TerminalBackend {
  terminal: TerminalInstance;
  fitAddon: IFitAddon;
  /** Create a WebGL addon for GPU rendering. Returns null if not applicable (ghostty-web). */
  createWebglAddon(): ITerminalAddon | null;
}
