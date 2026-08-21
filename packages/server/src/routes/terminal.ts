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
  /** Ablation only: restore the #260 leading-edge flush (first chunk after
   *  idle goes out immediately). Splits unsynchronized repaints — see the
   *  LEADING_EDGE note below. */
  leadingEdge?: boolean;
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

// Leading-edge flushing is OPT-IN for ablation only (AUTONOMOS_WS_COALESCE_LEADING=1).
// It was the #260 default — flush the first chunk after idle immediately for
// zero-latency echo — but it is exactly wrong for a TUI that repaints WITHOUT
// synchronized-output brackets (gemini-cli's Ink emits no DECSET 2026): the
// repaint's first PTY chunk is the ERASE half, the stream is idle >window
// between repaints, so the erase flushed alone and the redraw followed a
// window later — every repaint painted torn (~17/s, measured 265 split frame
// pairs per 15s live). Trailing-edge holds every chunk ≤ windowMs so a
// multi-chunk repaint lands in ONE frame, which xterm paints atomically:
// measured 0 split pairs, 0 blank-ending frames on the same live stream.
// Cost: ≤ windowMs added echo latency after idle — below one display frame.
const LEADING_EDGE = process.env.AUTONOMOS_WS_COALESCE_LEADING === "1";

/** Defaults read from env. Coalescing is ON by default — it eliminates
 *  burst-induced dropped frames (measured 12/31/65 → 0 at 1/4/12 MB on a real
 *  GPU) and cuts frame count ~570× (remote/multi-pane). Flushing is
 *  TRAILING-edge (see the LEADING_EDGE note above): repaints stay whole at the cost of
 *  ≤ windowMs echo latency after idle. Set
 *  `AUTONOMOS_WS_COALESCE=0` to fall back to the historical per-chunk send. */
export const DEFAULT_COALESCE: CoalesceOptions = {
  coalesce: process.env.AUTONOMOS_WS_COALESCE !== "0",
  windowMs: intEnv("AUTONOMOS_WS_COALESCE_MS", 5),
  leadingEdge: LEADING_EDGE,
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
  // Timestamp of the last send. Read ONLY by the ablation-only leading-edge
  // branch below; unused on the trailing-edge default path. 0 = never sent.
  let lastFlushAt = 0;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const data = pending.join("");
    pending = [];
    pendingBytes = 0;
    lastFlushAt = Date.now();
    try {
      ws.send(data);
    } catch {
      // Send failed on a dead/half-open socket. `pending` is already cleared,
      // so this coalesced frame is dropped FOR THIS SOCKET — but the bytes are
      // not lost: runtime.ts's per-session scrollback still has them and a
      // reconnecting client replays them. Quantify the drop so it's not silent.
      console.warn(
        `[terminal] dropped ${data.length}B coalesced frame on send failure`,
      );
      onSendError();
    }
  };

  return {
    onData: (data: string) => {
      pending.push(data);
      pendingBytes += data.length;
      // A full frame's worth accumulated → flush now.
      if (pendingBytes >= opts.maxBytes) {
        flush();
        return;
      }
      // Already coalescing within the current window — let the timer fire.
      if (timer) return;
      // Ablation-only leading edge (see LEADING_EDGE): flush an after-idle
      // chunk immediately. Default is trailing-edge — every chunk waits up to
      // windowMs for siblings so an unsynchronized repaint ships whole.
      if (opts.leadingEdge && Date.now() - lastFlushAt >= opts.windowMs) {
        flush();
        return;
      }
      timer = setTimeout(flush, opts.windowMs);
    },
    close: flush,
  };
}

// ── Replay coalescing (agent-switch fix, flag-gated) ───────────────────
// On connect the server replays the session's scrollback so a reconnecting
// client catches up. Historically that was one `ws.send()` PER STORED PTY
// CHUNK — a 1MB buffer of Ink-sized chunks fanned into ~19k frames, which is
// the multi-second "text rushing in" on every agent switch. The live-stream
// coalescer above never covered this path (it batches by TIME, and a replay
// is an already-complete sequence where time plays no role). Instead the
// buffered chunks are joined into a few large frames up front. Zero added
// latency: the join is synchronous and the replay is a one-shot burst.
export interface ReplayOptions {
  /** When false, behavior is byte-identical to the historical per-chunk send. */
  coalesce: boolean;
  /** Target frame size in UTF-16 code units (≈ bytes for ASCII/ANSI terminal
   *  output; multibyte glyphs make wire frames larger) — chunks are packed
   *  until a frame reaches this. Same counting convention as the live
   *  coalescer's maxBytes above. */
  maxBytes: number;
}

/** Defaults read from env. ON by default (measured: 18,829 replay frames →
 *  9-16 for a full 1MB buffer, byte-identical content). Set
 *  `AUTONOMOS_WS_REPLAY_COALESCE=0` to fall back to per-chunk replay. */
export const DEFAULT_REPLAY: ReplayOptions = {
  coalesce: process.env.AUTONOMOS_WS_REPLAY_COALESCE !== "0",
  maxBytes: intEnv("AUTONOMOS_WS_REPLAY_BYTES", 64 * 1024),
};

/**
 * Pack the buffered scrollback chunks into replay frames. Pure — order and
 * bytes are preserved exactly; only the frame boundaries change. A frame
 * closes once it reaches `maxBytes`, so a 1MB buffer becomes ~16 frames
 * (instead of one frame per chunk) while never building one giant string
 * before the first byte can go out.
 */
export function buildReplayFrames(
  chunks: readonly string[],
  opts: ReplayOptions = DEFAULT_REPLAY,
): string[] {
  if (!opts.coalesce) return [...chunks];
  const frames: string[] = [];
  let pending: string[] = [];
  let pendingBytes = 0;
  for (const chunk of chunks) {
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes >= opts.maxBytes) {
      frames.push(pending.join(""));
      pending = [];
      pendingBytes = 0;
    }
  }
  if (pending.length > 0) frames.push(pending.join(""));
  return frames;
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

        // Replay buffered output so reconnecting clients see scrollback —
        // packed into large frames (see buildReplayFrames) so an agent switch
        // doesn't fan a 1MB buffer into ~19k tiny WS frames.
        for (const frame of buildReplayFrames(managed.outputBuffer)) {
          try {
            ws.send(frame);
          } catch {
            // Client disconnected during replay
            return;
          }
        }

        const forwarder = makeStreamForwarder(ws, () => {
          // Send failed (slow/half-open client) — detach from the PTY stream.
          // Logged so a one-viewer terminal freeze leaves a breadcrumb instead
          // of silently going dark. Full teardown happens on the ensuing close.
          // INVARIANT: dispose() halts all future onData, so no further chunks
          // can accumulate in the (now coalescing-by-default) forwarder buffer
          // behind this dead socket. cleanupBinding's later flush is a no-op.
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
