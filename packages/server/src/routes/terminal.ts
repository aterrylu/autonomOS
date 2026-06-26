import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { IDisposable } from "node-pty";
import { getAttachment as getSession } from "../agents/runtime.js";

interface PtyBinding {
  sessionId: string;
  disposable: IDisposable;
  /** Tears down the coalescing flush timer (no-op when coalescing is off). */
  closeStream?: () => void;
}

const bindings = new WeakMap<WSContext, PtyBinding>();

// ── Frame coalescing (improvement #1, flag-gated) ──────────────────────
// On `main` the live stream does one `ws.send()` per PTY chunk. Claude Code's
// Ink TUI emits many tiny chunks per repaint, so a burst fans into thousands of
// frames. When enabled, PTY chunks are buffered per connection and flushed as a
// single frame on a short time window OR a size threshold (whichever comes
// first) — collapsing frame count ~10-100× while keeping interactive echo
// imperceptibly delayed. Default OFF → byte-identical to current behavior, so
// the ablation A/B is clean.
export interface CoalesceOptions {
  /** When false, behavior is byte-identical to the historical per-chunk send. */
  coalesce: boolean;
  /** Flush a partial buffer after this many ms of accumulation. */
  windowMs: number;
  /** Flush immediately once this many bytes are pending. */
  maxBytes: number;
}

/** Parse a non-negative integer env var, warning + falling back on a malformed
 *  value (so a typo can't silently skew the coalescing window/threshold). */
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[terminal] ignoring invalid ${name}=${raw}; using ${def}`);
    return def;
  }
  return n;
}

/** Defaults read from env so the ablation harness can flip behavior without a
 *  rebuild. `coalesce` defaults OFF → unchanged from `main`. */
export const DEFAULT_COALESCE: CoalesceOptions = {
  coalesce: process.env.AUTONOMOS_WS_COALESCE === "1",
  windowMs: intEnv("AUTONOMOS_WS_COALESCE_MS", 8),
  maxBytes: intEnv("AUTONOMOS_WS_COALESCE_BYTES", 16384),
};

/**
 * Build the per-connection PTY→WS forwarder. Returns the data handler plus a
 * `close()` that flushes any pending bytes and cancels the timer. When
 * coalescing is off the handler is the original immediate `ws.send`.
 */
export function makeStreamForwarder(
  ws: Pick<WSContext, "send">,
  onSendError: () => void,
  opts: CoalesceOptions = DEFAULT_COALESCE,
): { onData: (data: string) => void; close: () => void } {
  if (!opts.coalesce) {
    return {
      onData: (data: string) => {
        try {
          ws.send(data);
        } catch {
          onSendError();
        }
      },
      close: () => {},
    };
  }

  let pending: string[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const data = pending.join("");
    pending = [];
    pendingBytes = 0;
    try {
      ws.send(data);
    } catch {
      onSendError();
    }
  };

  return {
    onData: (data: string) => {
      pending.push(data);
      pendingBytes += data.length;
      // Flush immediately once a frame's worth has accumulated; otherwise
      // arm a short timer so trailing/interactive output isn't held back.
      if (pendingBytes >= opts.maxBytes) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, opts.windowMs);
      }
    },
    close: flush,
  };
}

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

        const forwarder = makeStreamForwarder(ws, () => {
          // Send failed (slow/half-open client) — detach from the PTY stream.
          // Logged so a one-viewer terminal freeze leaves a breadcrumb instead
          // of silently going dark. Full teardown happens on the ensuing close.
          console.warn(
            `[terminal] WS send failed for session ${sessionId}; detaching client`,
          );
          disposable.dispose();
        });
        const disposable = managed.pty.onData(forwarder.onData);

        bindings.set(ws, {
          sessionId,
          disposable,
          closeStream: forwarder.close,
        });

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
                // Flush any coalesced tail while the socket is still OPEN — the
                // close() below resolves asynchronously, so a flush after it
                // would send on a dead socket and silently drop the final
                // pre-exit output (last prompt / build summary). No-op when
                // coalescing is off (pending is always empty).
                bindings.get(client)?.closeStream?.();
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
  binding.closeStream?.();
  bindings.delete(ws);
  // Remove from session client tracking
  sessionClients.get(binding.sessionId)?.delete(ws);
}
