// IPC handlers exposed to the renderer via contextBridge (see preload/main.ts).
// Channel names live in shared/constants.ts; types live in shared/api.ts.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain, net, session } from "electron";

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
import { migrateToAlwaysOn, migrateToBuiltIn } from "./migrate.js";
import { acquireOrConnect, getActiveServer } from "./server-supervisor.js";
import {
  endDrag,
  openConnectionWindow,
  openWelcomeWindow,
  startDrag,
} from "./window-manager.js";

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
      // Special-case "local" — synthesized from the active server, not from
      // the stored connections list.
      if (id === "local") {
        const server = getActiveServer();
        if (!server) return { ok: false };
        const url = `http://127.0.0.1:${server.port}`;
        const partition = "persist:connection-local";
        // Only set the cookie if we actually have a token. Older daemons
        // (pre-1B.2.8) don't write ~/.autonomos/token, so server.token may
        // be empty. Empty-value cookies break Electron's cookies.set, and
        // even when they don't, the server rejects empty tokens. Letting
        // the dashboard's built-in login form appear is the right fallback —
        // the user pastes their token once and it goes into localStorage.
        if (server.token.length > 0) {
          try {
            const ses = session.fromPartition(partition);
            await ses.cookies.set({
              url,
              name: "autonomos_token",
              value: server.token,
              domain: "127.0.0.1",
              path: "/",
              secure: false,
              httpOnly: false,
              sameSite: "lax",
            });
          } catch (err) {
            // Cookie set failed — log but don't fail the prepare. The
            // webview will load and the dashboard will show its login form.
            console.warn("[ipc] cookie.set for local failed:", err);
          }
        }
        return { ok: true, url };
      }

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

  // ── Local server lifecycle (ADR-029) ──────────────────────────────

  ipcMain.handle(
    "local-server:info",
    (): {
      mode: "built-in" | "always-on";
      port: number;
      version: string;
    } | null => {
      const server = getActiveServer();
      if (!server) return null;
      return { mode: server.mode, port: server.port, version: server.version };
    },
  );

  ipcMain.handle(
    "local-server:migrate-to-always-on",
    async (): Promise<{ ok: boolean; message: string }> => {
      const result = await migrateToAlwaysOn();
      if (!result.ok) {
        return {
          ok: false,
          message: result.stderr || result.stdout || "Migration failed",
        };
      }
      // Re-acquire to pick up the new Always-on server.
      try {
        await acquireOrConnect();
        await buildMenu();
        return {
          ok: true,
          message: "autonomOS is now running in the background.",
        };
      } catch (err) {
        return {
          ok: false,
          message:
            "install-service succeeded but reconnect failed: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    },
  );

  ipcMain.handle(
    "local-server:migrate-to-built-in",
    async (): Promise<{ ok: boolean; message: string }> => {
      const result = await migrateToBuiltIn();
      if (!result.ok) {
        return {
          ok: false,
          message: result.stderr || result.stdout || "Migration failed",
        };
      }
      try {
        await acquireOrConnect();
        return { ok: true, message: "autonomOS is back to Built-in mode." };
      } catch (err) {
        return {
          ok: false,
          message:
            "uninstall-service succeeded but reconnect failed: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
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

  // Manual window drag — see window-manager.ts startDrag/endDrag for
  // implementation. -webkit-app-region: drag doesn't propagate from
  // <webview> guests, so we drive the drag from the main process by
  // polling screen.getCursorScreenPoint() while a drag is active.
  ipcMain.on("windows:drag-start", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) startDrag(win);
  });
  ipcMain.on("windows:drag-end", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) endDrag(win.id);
  });
}
