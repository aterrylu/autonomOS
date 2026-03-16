import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";

const HOME = process.env.HOME ?? "";

/** Resolve and validate that a file path is within the user's home directory. */
function safePath(filePath: string): string | null {
  const resolved = resolve(filePath);
  if (!HOME || !resolved.startsWith(`${HOME}/`)) return null;
  return resolved;
}

export const fileRouter = new Hono();

fileRouter.get("/read", (c) => {
  const filePath = c.req.query("path");
  if (!filePath) {
    return c.json({ error: "Missing ?path= parameter" }, 400);
  }

  const resolved = safePath(filePath);
  if (!resolved) {
    return c.json(
      { error: "Access denied — path must be within home directory" },
      403,
    );
  }

  if (!existsSync(resolved)) {
    return c.json({ error: "File not found" }, 404);
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    return c.json({ error: "Path is not a file" }, 400);
  }

  // Limit to reasonable file sizes (1MB)
  if (stat.size > 1024 * 1024) {
    return c.json({ error: "File too large (max 1MB)" }, 413);
  }

  const content = readFileSync(resolved, "utf-8");
  return c.json({ content, path: resolved, mtime: stat.mtimeMs });
});

/**
 * WebSocket endpoint for live file watching.
 * Sends { type: "update", content, mtime } when the file changes on disk.
 */
export function fileWatchRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket((c) => {
    const filePath = c.req.query("path");

    return {
      onOpen(_event, ws) {
        if (!filePath) {
          ws.close(4000, "Missing ?path= parameter");
          return;
        }

        const resolved = safePath(filePath);

        if (
          !resolved ||
          !existsSync(resolved) ||
          !statSync(resolved).isFile()
        ) {
          ws.close(4004, "File not found");
          return;
        }

        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const watcher = watch(resolved, () => {
          // Debounce rapid changes (e.g. editor save + format)
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            try {
              if (!existsSync(resolved)) return;
              const stat = statSync(resolved);
              if (stat.size > 1024 * 1024) return;
              const content = readFileSync(resolved, "utf-8");
              ws.send(
                JSON.stringify({
                  type: "update",
                  content,
                  mtime: stat.mtimeMs,
                }),
              );
            } catch {
              // File might be temporarily unavailable during writes
            }
          }, 100);
        });

        // Store watcher reference for cleanup
        watcherMap.set(ws, { watcher, debounceTimer: () => debounceTimer });
      },

      onClose(_event, ws) {
        cleanupWatcher(ws);
      },

      onError(_event, ws) {
        cleanupWatcher(ws);
      },
    };
  });
}

const watcherMap = new WeakMap<
  WSContext,
  {
    watcher: ReturnType<typeof watch>;
    debounceTimer: () => ReturnType<typeof setTimeout> | null;
  }
>();

function cleanupWatcher(ws: WSContext): void {
  const entry = watcherMap.get(ws);
  if (!entry) return;
  entry.watcher.close();
  const timer = entry.debounceTimer();
  if (timer) clearTimeout(timer);
  watcherMap.delete(ws);
}
