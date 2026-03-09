import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { IDisposable } from "node-pty";
import { getSession } from "../sessions.js";

interface PtyBinding {
  sessionId: string;
  disposable: IDisposable;
}

const bindings = new WeakMap<WSContext, PtyBinding>();

/** Track all WebSocket clients per session so we can notify on PTY exit */
const sessionClients = new Map<string, Set<WSContext>>();

/** Sessions that already have an onExit handler registered */
const exitHandlerRegistered = new Set<string>();

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

/**
 * WebSocket endpoint for terminal streaming.
 *
 * Flow:
 * 1. Client connects to /ws/terminal/:sessionId
 * 2. Server attaches to the session's PTY
 * 3. PTY output -> WebSocket -> xterm.js
 * 4. xterm.js keystrokes -> WebSocket -> PTY input
 * 5. Resize messages from client -> PTY resize
 *
 * WebSocket disconnect does NOT kill the session — sessions
 * persist independently and can be reconnected to.
 */
export function terminalRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket((c) => {
    const sessionId = c.req.param("sessionId")!;

    return {
      onOpen(_event, ws) {
        const managed = getSession(sessionId);
        if (!managed) {
          ws.close(4004, "Session not found");
          return;
        }

        // Replay buffered output so reconnecting clients see scrollback
        for (const chunk of managed.outputBuffer) {
          try {
            ws.send(chunk);
          } catch {
            // Client disconnected during replay
            return;
          }
        }

        const disposable = managed.pty.onData((data: string) => {
          try {
            ws.send(data);
          } catch {
            disposable.dispose();
          }
        });

        bindings.set(ws, { sessionId, disposable });

        // Track this client for PTY exit notification
        if (!sessionClients.has(sessionId))
          sessionClients.set(sessionId, new Set());
        sessionClients.get(sessionId)!.add(ws);

        // Register onExit once per session to avoid duplicate handlers
        if (!exitHandlerRegistered.has(sessionId)) {
          exitHandlerRegistered.add(sessionId);
          managed.pty.onExit(() => {
            const tracked = sessionClients.get(sessionId);
            if (tracked) {
              for (const client of tracked) {
                try {
                  client.close(4010, "Session ended");
                } catch {
                  // Client already gone
                }
              }
            }
            sessionClients.delete(sessionId);
            exitHandlerRegistered.delete(sessionId);
          });
        }
      },

      onMessage(event, ws) {
        const binding = bindings.get(ws);
        if (!binding) return;

        const managed = getSession(binding.sessionId);
        if (!managed) return;

        const msg =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);

        // Handle resize messages (JSON with type: "resize")
        if (msg.startsWith("{")) {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(msg);
          } catch {
            // Not valid JSON — fall through to pty.write()
          }
          if (parsed?.type === "resize") {
            const cols = Number(parsed.cols);
            const rows = Number(parsed.rows);
            if (
              Number.isInteger(cols) &&
              Number.isInteger(rows) &&
              cols >= MIN_COLS &&
              cols <= MAX_COLS &&
              rows >= MIN_ROWS &&
              rows <= MAX_ROWS
            ) {
              try {
                managed.pty.resize(cols, rows);
              } catch (err) {
                console.error(
                  `Resize failed for session ${binding.sessionId}:`,
                  err,
                );
              }
            }
            return;
          }
        }

        try {
          managed.pty.write(msg);
        } catch (err) {
          console.error(
            `PTY write failed for session ${binding.sessionId}:`,
            err,
          );
          ws.close(4001, "PTY write failed");
        }
      },

      onClose(_event, ws) {
        cleanupBinding(ws);
      },

      onError(_event, ws) {
        cleanupBinding(ws);
      },
    };
  });
}

function cleanupBinding(ws: WSContext): void {
  const binding = bindings.get(ws);
  if (!binding) return;
  binding.disposable.dispose();
  bindings.delete(ws);
  // Remove from session client tracking
  sessionClients.get(binding.sessionId)?.delete(ws);
}
