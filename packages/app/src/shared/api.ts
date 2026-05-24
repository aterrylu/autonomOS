// Typed IPC contract between main and renderer. Both sides import these
// types so the contextBridge surface stays in sync.

import type { Connection } from "../types/connection.js";

export interface AddConnectionInput {
  /** Base URL of the autonomos-server (no trailing slash). */
  url: string;
  /** Bearer token from the server's install.sh output (or `~/.autonomos/token`). */
  token: string;
  /** Display name; if absent, derived from the URL hostname. */
  name?: string;
}

export interface LocalServerStatus {
  installed: boolean;
  running: boolean;
  port: number | null;
  version: string | null;
}

export type AddConnectionResult =
  | { ok: true; connection: Connection }
  | {
      ok: false;
      error: "invalid-url" | "unreachable" | "invalid-token" | "unknown";
      message: string;
    };

/** Surface exposed to the renderer via contextBridge as `window.autonomos`. */
export interface AutonomosAPI {
  connections: {
    list(): Promise<Connection[]>;
    add(input: AddConnectionInput): Promise<AddConnectionResult>;
    remove(id: string): Promise<void>;
  };
  localServer: {
    status(): Promise<LocalServerStatus>;
  };
  encryption: {
    isAvailable(): Promise<boolean>;
  };
  webview: {
    prepare(id: string): Promise<{ ok: true; url: string } | { ok: false }>;
  };
  windows: {
    /** Open a new BrowserWindow for the given connection (or focus the
     *  existing one if it's already open). */
    openConnection(id: string): Promise<void>;
    /** Open a fresh Welcome window for adding a new connection. */
    newWelcome(): Promise<void>;
    /** Close the BrowserWindow that owns the calling renderer. */
    closeSelf(): Promise<void>;
    /** Manual window-drag protocol. The webview preload signals
     *  "drag-start" on mousedown in the dashboard header and "drag-end"
     *  on mouseup; the main process polls the cursor via
     *  screen.getCursorScreenPoint() at ~120Hz between those events
     *  and calls win.setPosition() each tick. Replaces
     *  -webkit-app-region: drag for <webview> content where the CSS
     *  property doesn't propagate to the host BrowserWindow. */
    dragStart(): void;
    dragEnd(): void;
  };
  /** Bumped when the contract changes in a breaking way. */
  version: number;
}

/** Augmentation for the renderer-side `window` object. */
declare global {
  interface Window {
    autonomos: AutonomosAPI;
  }
}
