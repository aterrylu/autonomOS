// IPC handlers exposed to the renderer via contextBridge (see preload/main.ts).
// Channel names live in shared/constants.ts; types live in shared/api.ts.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcMain, net } from "electron";
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

/** Read ~/.autonomos/autonomos.pid (the source of truth for the local
 *  daemon's port/pid/version). Returns null on missing/corrupt/dead-process. */
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
    // POSIX kill(pid, 0) — sends no signal, throws if process doesn't exist.
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

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

type ValidationError = Extract<AddConnectionResult, { ok: false }>["error"];

/** Validate a remote server by hitting its authenticated /api/system/version
 *  with a 5s timeout. Returns null iff status 200, else the error code. */
async function validateRemote(
  url: string,
  token: string,
): Promise<ValidationError | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid-url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "invalid-url";
  }

  return new Promise((resolve) => {
    const req = net.request({
      method: "GET",
      url: `${normalizeUrl(url)}/api/system/version`,
    });
    req.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => {
      req.abort();
      resolve("unreachable");
    }, 5000);
    req.on("response", (res) => {
      clearTimeout(timer);
      // Drain body so the request closes cleanly.
      res.on("data", () => undefined);
      res.on("end", () => undefined);
      if (res.statusCode === 200) resolve(null);
      else if (res.statusCode === 401 || res.statusCode === 403)
        resolve("invalid-token");
      else resolve("unknown");
    });
    req.on("error", () => {
      clearTimeout(timer);
      resolve("unreachable");
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
      const validationError = await validateRemote(url, input.token);
      if (validationError) {
        return {
          ok: false,
          error: validationError,
          message:
            validationError === "invalid-url"
              ? "Not a valid http(s):// URL."
              : validationError === "unreachable"
                ? "Server unreachable. Check the URL and that the daemon is running."
                : validationError === "invalid-token"
                  ? "Invalid token."
                  : "Unknown error contacting the server.",
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
        defaultConnectionId:
          current.defaultConnectionId === id
            ? null
            : current.defaultConnectionId,
      }));
    },
  );

  ipcMain.handle(
    IPC.CONNECTIONS_SET_DEFAULT,
    async (_event, id: string | null): Promise<void> => {
      await setConfig((current) => ({ ...current, defaultConnectionId: id }));
    },
  );

  ipcMain.handle(
    "connections:get-default",
    async (): Promise<string | null> => {
      const config = await getConfig();
      return config.defaultConnectionId;
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

  // For 1B.2.3+ — internal use only, not on the AutonomosAPI surface yet.
  ipcMain.handle(
    "internal:get-token",
    async (_event, id: string): Promise<string | null> => {
      return getToken(id);
    },
  );
}
