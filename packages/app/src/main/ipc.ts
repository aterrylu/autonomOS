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
import {
  acquireEphemeral,
  acquireOrConnect,
  getActiveServer,
} from "./server-supervisor.js";
import {
  endDrag,
  openConnectionWindow,
  openWelcomeWindow,
  startDrag,
  waitForConnectionWindowReady,
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

  /** Prepare a partition's session to load the connection's web dashboard.
   *
   *  We try two complementary auth-bootstrap paths and return whichever
   *  context the host renderer needs to drive both:
   *
   *  1. `session.cookies.set()` — pre-seeds an `autonomos_token` cookie on
   *     the webview's partition. When this works, the dashboard's auth
   *     probe (GET /api/agents on mount) sees the cookie and proceeds
   *     directly to the authenticated view — no flash of login form.
   *
   *  2. `bootstrapToken` returned to the host renderer — used as a
   *     fallback by ConnectionWebview on `did-finish-load`: POST /auth
   *     via executeJavaScript, which sets the server-side httpOnly cookie
   *     and reloads. Same path as the dashboard's own login form, so it's
   *     well-tested. Belt-and-suspenders against silent cookies.set bugs.
   *
   *  **Security model:** local-connection bootstrap is only ever exposed
   *  to the in-process renderer of this Electron app — the embedded
   *  server binds 127.0.0.1 only (see embedded-mode.ts), so no network
   *  attacker reaches it. The token never appears in the URL, never
   *  appears in process command-line args, and the cookie itself is
   *  `httpOnly: true` (set server-side via POST /auth) so dashboard JS
   *  can't read it.
   */
  ipcMain.handle(
    "connections:prepare-webview",
    async (
      _event,
      id: string,
    ): Promise<
      { ok: true; url: string; bootstrapToken?: string } | { ok: false }
    > => {
      // Special-case "local" — synthesized from the active server, not from
      // the stored connections list.
      if (id === "local") {
        const server = getActiveServer();
        if (!server) return { ok: false };
        const url = `http://127.0.0.1:${server.port}`;
        const partition = "persist:connection-local";
        // Only set the cookie if we actually have a token. Older daemons
        // (pre-1B.2.8) don't write ~/.autonomos/token, so server.token may
        // be empty.
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
            // cookies.set failed — log but don't fail prepare. The
            // bootstrapToken fallback below handles this case.
            console.warn("[ipc] cookie.set for local failed:", err);
          }
        }
        // Return the token alongside the URL so the host renderer can
        // bootstrap auth via POST /auth on did-finish-load. Safe to expose
        // here: the host renderer is in-process Electron, same security
        // boundary as the main process.
        return {
          ok: true,
          url,
          ...(server.token.length > 0 ? { bootstrapToken: server.token } : {}),
        };
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
      // Remote connections get the same bootstrapToken safety net.
      return { ok: true, url: conn.url, bootstrapToken: token };
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

  /** Detect a running daemon WITHOUT claiming. Used by the Welcome
   *  screen to surface the "Always-on" card state.
   *
   *  Layered detection:
   *    1. ~/.autonomos/autonomos.pid (preferred — gives pid + version)
   *    2. Conventional default port 3100 (fallback for older servers
   *       that don't write pid files)
   *
   *  Returns the first signal that succeeds. Older daemons get
   *  pid=0, version="unknown" but still register as Always-on. */
  ipcMain.handle(
    "local-server:detect",
    async (): Promise<
      | { running: true; port: number; pid: number; version: string }
      | { running: false }
    > => {
      // Helper: probe whether a port has anything HTTP-ish listening.
      const isPortAlive = (port: number, timeoutMs = 800): Promise<boolean> =>
        new Promise((res) => {
          const req = net.request({
            method: "GET",
            url: `http://127.0.0.1:${port}/api/system/version`,
          });
          let done = false;
          const settle = (v: boolean): void => {
            if (done) return;
            done = true;
            res(v);
          };
          const timer = setTimeout(() => {
            req.abort();
            settle(false);
          }, timeoutMs);
          req.on("response", (response) => {
            clearTimeout(timer);
            response.on("data", () => undefined);
            response.on("end", () => undefined);
            settle(true);
          });
          req.on("error", () => {
            clearTimeout(timer);
            settle(false);
          });
          req.end();
        });

      // Path 1: pid file (preferred)
      const pidPath = join(homedir(), ".autonomos", "autonomos.pid");
      if (existsSync(pidPath)) {
        try {
          const data = JSON.parse(readFileSync(pidPath, "utf-8")) as {
            pid: number;
            port: number;
            version: string;
          };
          let alive = false;
          try {
            process.kill(data.pid, 0);
            alive = true;
          } catch {
            // pid dead — fall through to port probe.
          }
          if (alive && (await isPortAlive(data.port))) {
            return {
              running: true,
              port: data.port,
              pid: data.pid,
              version: data.version,
            };
          }
        } catch {
          // Corrupt pid file — fall through to port probe.
        }
      }

      // Path 2: port probe on the conventional default (catches older
      // daemons that don't write a pid file, or pid files we couldn't
      // parse).
      if (await isPortAlive(3100)) {
        return {
          running: true,
          port: 3100,
          pid: 0,
          version: "unknown",
        };
      }

      return { running: false };
    },
  );

  /** Acquire the local server — connect to existing daemon or spawn
   *  Built-in. Called when user picks "This Mac" / "Built-in" in Welcome. */
  ipcMain.handle(
    "local-server:acquire",
    async (): Promise<{ ok: boolean; message?: string }> => {
      try {
        await acquireOrConnect();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /** Acquire an ephemeral "Try it out" server — spawn a fresh server in an
   *  isolated temp config dir. Nothing touches the user's ~/.autonomos/.
   *  The temp dir is rm-rf'd on Desktop quit via shutdownBuiltInServer(). */
  ipcMain.handle(
    "local-server:acquire-ephemeral",
    async (): Promise<{ ok: boolean; message?: string }> => {
      try {
        await acquireEphemeral();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
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

  ipcMain.handle(
    "windows:open-connection",
    async (_event, id: string): Promise<void> => {
      openConnectionWindow(id);
      // Wait for the new window to actually be visible before returning,
      // so the calling renderer (e.g. WelcomeWindow.handlePickLocal) can
      // safely close itself without the new window getting orphaned
      // behind the closing one. macOS-specific glitch but cheap insurance
      // everywhere.
      await waitForConnectionWindowReady(id);
    },
  );

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
