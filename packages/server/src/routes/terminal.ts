import type { UpgradeWebSocket } from "hono/ws";
import { getSession } from "../sessions";

/**
 * WebSocket endpoint for terminal streaming.
 *
 * The flow:
 * 1. Client connects to /ws/terminal/:sessionId
 * 2. Server attaches to the session's PTY
 * 3. PTY output → WebSocket → xterm.js (binary stream)
 * 4. xterm.js keystrokes → WebSocket → PTY input
 * 5. Resize messages from client → PTY resize
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

        const { pty } = managed;

        // PTY output → WebSocket
        const disposable = pty.onData((data: string) => {
          ws.send(data);
        });

        // Store cleanup reference on the ws object
        (ws as any)._ptyDisposable = disposable;
        (ws as any)._sessionId = sessionId;
      },

      onMessage(event, ws) {
        const managed = getSession((ws as any)._sessionId);
        if (!managed) return;

        const msg = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);

        // Handle resize messages (JSON with type: "resize")
        if (msg.startsWith("{")) {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.type === "resize" && parsed.cols && parsed.rows) {
              managed.pty.resize(parsed.cols, parsed.rows);
              return;
            }
          } catch {
            // Not JSON — treat as regular input
          }
        }

        // Regular input → PTY
        managed.pty.write(msg);
      },

      onClose(_event, ws) {
        const disposable = (ws as any)._ptyDisposable;
        if (disposable?.dispose) disposable.dispose();
      },
    };
  });
}
