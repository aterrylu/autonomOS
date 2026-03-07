import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { IDisposable } from "node-pty";
import { getSession, killSession } from "../sessions.js";

interface PtyBinding {
  sessionId: string;
  disposable: IDisposable;
}

const bindings = new WeakMap<WSContext, PtyBinding>();

/**
 * WebSocket endpoint for terminal streaming.
 *
 * Flow:
 * 1. Client connects to /ws/terminal/:sessionId
 * 2. Server attaches to the session's PTY
 * 3. PTY output -> WebSocket -> xterm.js
 * 4. xterm.js keystrokes -> WebSocket -> PTY input
 * 5. Resize messages from client -> PTY resize
 */
export function terminalRouter(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket((c) => {
    const sessionId = c.req.param("sessionId");

    return {
      onOpen(_event, ws) {
        const managed = getSession(sessionId);
        if (!managed) {
          ws.close(4004, "Session not found");
          return;
        }

        const disposable = managed.pty.onData((data: string) => {
          try {
            ws.send(data);
          } catch {
            disposable.dispose();
          }
        });

        bindings.set(ws, { sessionId, disposable });
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
            // Not valid JSON -- fall through to pty.write()
          }
          if (parsed?.type === "resize" && parsed.cols && parsed.rows) {
            try {
              managed.pty.resize(
                parsed.cols as number,
                parsed.rows as number
              );
            } catch (err) {
              console.error(`Resize failed for session ${binding.sessionId}:`, err);
            }
            return;
          }
        }

        try {
          managed.pty.write(msg);
        } catch (err) {
          console.error(`PTY write failed for session ${binding.sessionId}:`, err);
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
  killSession(binding.sessionId);
}
