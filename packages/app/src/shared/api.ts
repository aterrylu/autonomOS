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
  /** LaunchAgent / systemd-user service has been installed for this binary. */
  installed: boolean;
  /** A daemon is currently responding (autonomos.pid exists, pid alive). */
  running: boolean;
  /** Port from ~/.autonomos/autonomos.pid (read fresh; null if not running). */
  port: number | null;
  /** Server version from autonomos.pid (null if not running). */
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
    setDefault(id: string | null): Promise<void>;
    getDefault(): Promise<string | null>;
  };
  localServer: {
    status(): Promise<LocalServerStatus>;
  };
  encryption: {
    isAvailable(): Promise<boolean>;
  };
  webview: {
    /** Prepare a partition's session to load the connection's dashboard
     *  by setting the `autonomos_token` cookie. Call immediately before
     *  mounting a <webview> with partition="persist:connection-${id}".
     *  Returns the URL to load on success. */
    prepare(id: string): Promise<{ ok: true; url: string } | { ok: false }>;
  };
  /** Bumped when the contract changes in a breaking way. */
  version: number;
}

/** Augmentation for the renderer-side `window` object. Renderer code can
 *  `window.autonomos.connections.list()` with full type safety. */
declare global {
  interface Window {
    autonomos: AutonomosAPI;
  }
}
