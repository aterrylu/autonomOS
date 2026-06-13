import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { IDisposable } from "node-pty";
import { getAttachment as getSession } from "../agents/runtime.js";

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
 * Device-query / report-request control sequences that a terminal emulator
 * auto-*answers* when it parses them. These show up in the PTY scrollback
 * because the running app (Claude Code / Ink) emitted them to stdout at
 * startup. On reconnect we replay that scrollback verbatim — and xterm.js,
 * re-parsing the queries as if they were live, generates the responses and
 * sends them back through onData → PTY stdin. The app, sitting at its prompt,
 * inserts those report bytes as literal input → gibberish in the input line.
 *
 * Stripping them from the *replay* is display-safe: every sequence below
 * renders nothing on screen, it only solicits a response. The live PTY stream
 * after attach is left untouched — real-time queries (e.g. on resize) still
 * deserve real answers.
 *
 *   ESC[c, ESC[>c, ESC[?…c          Device Attributes (DA1/2/3, + responses)
 *   ESC[5n, ESC[6n, ESC[?…n         Device Status / cursor-position report
 *   ESC[?…$p                        DECRQM (mode query, e.g. ?2026 sync output)
 *   ESC[>…q                         XTVERSION request
 *   ESC[?…u                         kitty keyboard-flags query / response
 *   ESC]{10,11,12};?  ESC]4;n;?     OSC color / palette queries (BEL or ST)
 */
const DEVICE_QUERY_SEQ =
  /\x1b\[[?>=]?[0-9;]*[cn]|\x1b\[\?[0-9;]*\$p|\x1b\[>[0-9]*q|\x1b\[\?[0-9]*u|\x1b\](?:1[012]|4;[0-9]+);\?(?:\x07|\x1b\\)/g;

/**
 * Strip device-query/report-request sequences from a replay buffer.
 * Operates on the concatenated buffer (not per-chunk) so a query split
 * across two PTY chunks is still matched as a whole.
 */
export function stripReplayDeviceQueries(replay: string): string {
  return replay.replace(DEVICE_QUERY_SEQ, "");
}

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

        // Replay buffered output so reconnecting clients see scrollback.
        // Concatenate first, then strip device-query sequences as a whole —
        // otherwise a query split across two chunks would slip through and
        // the client would auto-answer it into the PTY (gibberish at the
        // prompt). See stripReplayDeviceQueries.
        try {
          ws.send(stripReplayDeviceQueries(managed.outputBuffer.join("")));
        } catch {
          // Client disconnected during replay
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
