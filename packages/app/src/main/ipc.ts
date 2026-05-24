// IPC handlers exposed to the renderer via contextBridge (see preload/main.ts).
// Channel names live in shared/constants.ts; types live in shared/api.ts.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain, net, screen, session } from "electron";

import type {
  AddConnectionInput,
  AddConnectionResult,
  LocalServerStatus,
} from "../shared/api.js";
import { IPC } from "../shared/constants.js";
import type { Connection } from "../types/connection.js";
import { getConfig, setConfig } from "./config/store.js";
import {
  getToken,
  isEncryptionAvailable,
  removeToken,
  setToken,
} from "./config/tokens.js";
import { buildMenu } from "./menu.js";
import { openConnectionWindow, openWelcomeWindow } from "./window-manager.js";

/** Read ~/.autonomos/autonomos.pid (source of truth for the local daemon's
 *  port/pid/version). Returns null on missing/corrupt/dead-process. */
function readLocalPidFile(): {
  pid: number;
  port: number;
  version: string;
} | null {
  const path = join(homedir(), ".autonomos", "autonomos.pid");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { pid?: unknown }).pid !== "number" ||
      typeof (data as { port?: unknown }).port !== "number" ||
      typeof (data as { version?: unknown }).version !== "string"
    ) {
      return null;
    }
    const { pid, port, version } = data as {
      pid: number;
      port: number;
      version: string;
    };
    try {
      process.kill(pid, 0);
    } catch {
      return null;
    }
    return { pid, port, version };
  } catch {
    return null;
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "server";
  }
}

/** Normalize a user-typed URL: trim, strip trailing slashes, auto-prepend
 *  http:// if the user typed a bare host[:port]. */
function normalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url;
}

type ValidationError = Extract<AddConnectionResult, { ok: false }>["error"];

interface ValidationOutcome {
  error: ValidationError | null;
  details?: string;
}

async function validateRemote(
  url: string,
  token: string,
): Promise<ValidationOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    return {
      error: "invalid-url",
      details: err instanceof Error ? err.message : String(err),
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      error: "invalid-url",
      details: `Protocol ${parsed.protocol} not supported — use http:// or https://`,
    };
  }

  return new Promise((resolve) => {
    const requestUrl = `${url}/api/system/version`;
    const req = net.request({ method: "GET", url: requestUrl });
    req.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => {
      req.abort();
      resolve({
        error: "unreachable",
        details: `Timed out after 5s on ${requestUrl}`,
      });
    }, 5000);
    req.on("response", (res) => {
      clearTimeout(timer);
      res.on("data", () => undefined);
      res.on("end", () => undefined);
      if (res.statusCode === 200) resolve({ error: null });
      else if (res.statusCode === 401 || res.statusCode === 403)
        resolve({
          error: "invalid-token",
          details: `Server returned ${res.statusCode} on /api/system/version`,
        });
      else
        resolve({
          error: "unknown",
          details: `Server returned ${res.statusCode} on /api/system/version`,
        });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        error: "unreachable",
        details: `${err.message} (${requestUrl})`,
      });
    });
    req.end();
  });
}

export function registerIpc(): void {
  ipcMain.handle(IPC.CONNECTIONS_LIST, async (): Promise<Connection[]> => {
    const config = await getConfig();
    return config.connections;
  });

  ipcMain.handle(
    IPC.CONNECTIONS_ADD,
    async (_event, input: AddConnectionInput): Promise<AddConnectionResult> => {
      const url = normalizeUrl(input.url);
      const outcome = await validateRemote(url, input.token);
      if (outcome.error) {
        const baseMessage =
          outcome.error === "invalid-url"
            ? "Not a valid URL."
            : outcome.error === "unreachable"
              ? "Server unreachable. Check the URL and that the daemon is running."
              : outcome.error === "invalid-token"
                ? "Invalid token."
                : "Unknown error contacting the server.";
        return {
          ok: false,
          error: outcome.error,
          message: outcome.details
            ? `${baseMessage} (${outcome.details})`
            : baseMessage,
        };
      }

      const id = crypto.randomUUID();
      const connection: Connection = {
        id,
        name: input.name?.trim() || deriveNameFromUrl(url),
        type: "remote",
        url,
        lastConnectedAt: new Date().toISOString(),
      };

      await setToken(id, input.token);
      await setConfig((current) => ({
        ...current,
        connections: [...current.connections, connection],
      }));
      // Connections changed — rebuild the File > Recent Servers menu.
      await buildMenu();
      return { ok: true, connection };
    },
  );

  ipcMain.handle(
    IPC.CONNECTIONS_REMOVE,
    async (_event, id: string): Promise<void> => {
      await removeToken(id);
      await setConfig((current) => ({
        ...current,
        connections: current.connections.filter((c) => c.id !== id),
        openWindows: current.openWindows.filter((wid) => wid !== id),
      }));
      await buildMenu();
    },
  );

  ipcMain.handle(
    IPC.LOCAL_SERVER_STATUS,
    async (): Promise<LocalServerStatus> => {
      const config = await getConfig();
      const pidInfo = readLocalPidFile();
      return {
        installed: config.localServer.installed,
        running: pidInfo !== null,
        port: pidInfo?.port ?? null,
        version: pidInfo?.version ?? null,
      };
    },
  );

  ipcMain.handle("encryption:is-available", async (): Promise<boolean> => {
    return isEncryptionAvailable();
  });

  ipcMain.handle(
    "internal:get-token",
    async (_event, id: string): Promise<string | null> => {
      return getToken(id);
    },
  );

  /** Prepares a partition's session to load the connection's web dashboard
   *  by setting the `autonomos_token` cookie. */
  ipcMain.handle(
    "connections:prepare-webview",
    async (
      _event,
      id: string,
    ): Promise<{ ok: true; url: string } | { ok: false }> => {
      const config = await getConfig();
      const conn = config.connections.find((c) => c.id === id);
      if (!conn) return { ok: false };
      const token = await getToken(id);
      if (!token) return { ok: false };

      const partition = `persist:connection-${id}`;
      const ses = session.fromPartition(partition);
      const parsed = new URL(conn.url);
      await ses.cookies.set({
        url: conn.url,
        name: "autonomos_token",
        value: token,
        domain: parsed.hostname,
        path: "/",
        secure: parsed.protocol === "https:",
        httpOnly: false,
        sameSite: "lax",
      });
      return { ok: true, url: conn.url };
    },
  );

  // ── Window management ──────────────────────────────────────────────

  ipcMain.handle("windows:open-connection", (_event, id: string): void => {
    openConnectionWindow(id);
  });

  ipcMain.handle("windows:new-welcome", (): void => {
    openWelcomeWindow();
  });

  ipcMain.handle("windows:close-self", (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  /** Manual window drag for the BrowserWindow that owns the calling
   *  renderer. Used by ConnectionWebview when a mousedown lands in the
   *  dashboard's <header> — `-webkit-app-region: drag` doesn't propagate
   *  from <webview> guest pages to the host BrowserWindow.
   *
   *  Implementation: instead of following webview mousemove events
   *  (which stop firing the instant the cursor exits the window — fast
   *  drags would lose tracking near the window edge), we poll the
   *  cursor position from the main process via screen.getCursorScreenPoint()
   *  at ~120Hz until the renderer signals drag-end. This is how
   *  native window drags behave: the OS captures the cursor for the
   *  duration of the drag regardless of which window it's over.
   *
   *  Protocol:
   *    drag-start → record cursor-to-window offset, start polling
   *    drag-end   → stop polling */
  interface DragState {
    offsetX: number;
    offsetY: number;
    interval: NodeJS.Timeout;
  }
  const drags = new Map<number, DragState>();

  function endDrag(winId: number): void {
    const state = drags.get(winId);
    if (!state) return;
    clearInterval(state.interval);
    drags.delete(winId);
  }

  ipcMain.on("windows:drag-start", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    endDrag(win.id); // belt-and-suspenders: clear any stale interval

    // Read cursor and window position TOGETHER so the offset is computed
    // from a consistent snapshot. Using getCursorScreenPoint() here
    // (rather than trusting the mousedown event's screenX/Y) means we
    // don't have to ship coords through IPC and don't have to worry
    // about Retina scaling — getCursorScreenPoint() returns the same
    // coordinate space as setPosition().
    const cursor = screen.getCursorScreenPoint();
    const pos = win.getPosition();
    const winX = pos[0] ?? 0;
    const winY = pos[1] ?? 0;
    const offsetX = cursor.x - winX;
    const offsetY = cursor.y - winY;

    // Poll cursor at ~120Hz (8.33ms). setPosition under that flickers
    // anyway; this matches what native drag handlers produce.
    const interval = setInterval(() => {
      const c = screen.getCursorScreenPoint();
      // win.isDestroyed() guards against the window closing mid-drag.
      if (win.isDestroyed()) {
        endDrag(win.id);
        return;
      }
      win.setPosition(c.x - offsetX, c.y - offsetY, false);
    }, 8);

    drags.set(win.id, { offsetX, offsetY, interval });
  });

  ipcMain.on("windows:drag-end", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) endDrag(win.id);
  });

  // Kept for backwards-compat with the renderer's API surface; now a
  // no-op since the main process polls the cursor on its own. The
  // renderer's mousemove → dragMove pathway just becomes wasted IPC
  // traffic during a drag, harmless but unnecessary.
  ipcMain.on("windows:drag-move", (): void => {
    // intentionally empty
  });
}
