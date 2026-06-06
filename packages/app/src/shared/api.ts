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
    /** Mode of the currently-active "This Mac" server, or null if none. */
    info(): Promise<{
      mode: "built-in" | "always-on";
      port: number;
      version: string;
    } | null>;
    /** Detect whether a daemon is already running on this Mac WITHOUT
     *  claiming it. Used by the Welcome screen. */
    detect(): Promise<
      | { running: true; port: number; pid: number; version: string }
      | { running: false }
    >;
    /** Acquire the local server (Built-in spawn if no owner, else connect
     *  to existing daemon). Called when user picks "This Mac" in Welcome. */
    acquire(): Promise<{ ok: boolean; message?: string }>;
    /** Spawn an ephemeral "Try it out" server in an isolated temp dir.
     *  No state persists — temp dir is cleared when the Desktop quits.
     *  Never touches ~/.autonomos/. */
    acquireEphemeral(): Promise<{ ok: boolean; message?: string }>;
    /** Built-in → Always-on (installs LaunchAgent / systemd-user). */
    migrateToAlwaysOn(): Promise<{ ok: boolean; message: string }>;
    /** Always-on → Built-in (uninstalls LaunchAgent). */
    migrateToBuiltIn(): Promise<{ ok: boolean; message: string }>;
  };
  encryption: {
    isAvailable(): Promise<boolean>;
  };
  webview: {
    prepare(
      id: string,
    ): Promise<
      { ok: true; url: string; bootstrapToken?: string } | { ok: false }
    >;
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
