/**
 * Codex inbound delivery — the native equivalent of Claude Code "channels".
 *
 * Claude Code receives inbound messages through its channel-server subprocess
 * (an MCP notification surfaced into the live TUI). Codex has no such path; its
 * terminal-preserving inbound works by injecting a turn into the agent's
 * app-server daemon (A1), which the daemon broadcasts to every subscriber —
 * including the human's `codex --remote` TUI — so it renders inline.
 *
 * The gateway opens a SECOND JSON-RPC client to each Codex agent's daemon (the
 * TUI is the first). It is a NON-creator of the thread, so it can't subscribe to
 * full turn events (`thread/resume` → "no rollout") and must NOT rely on
 * edge-triggered `thread/status/changed` for idle (a single missed event would
 * wedge the queue forever). Instead it QUERIES ground truth via `thread/read`
 * (`thread.status.type` = "idle" | "active") right before each injection —
 * polling is dumb but can't get stuck, and self-corrects every cycle. Injecting
 * a `turn/start` mid-turn interleaves/corrupts, so we queue inbound and inject
 * one turn per confirmed-idle window.
 *
 * Delivery is best-effort + async (the sender's send() is acknowledged on
 * ENQUEUE; the turn lands when the agent next goes idle). Hard, persistent
 * failures (daemon unreachable, no thread ever appears) are surfaced to the
 * operator via the injected notifier, not just stdout.
 *
 * No autonomOS imports here (endpoint passed in, notifier injected) — keeps this
 * free of an import cycle with the runtime, which calls dispose() on teardown.
 */

const log = (...a: unknown[]) => console.log("[codex-inbound]", ...a);

/** How often to re-check thread status while waiting for an idle window. */
const IDLE_POLL_MS = 1_500;
/** Max time to wait for a single in-flight turn to finish before giving up a
 *  drain pass (agents can legitimately work for many minutes). */
const IDLE_DEADLINE_MS = 15 * 60_000;
/** Max time to wait for the TUI to create its thread before backing off. */
const THREAD_WAIT_MS = 60_000;
/** Backoff before re-attempting a drain after a transient failure. */
const RETRY_BACKOFF_MS = 5_000;
/** Consecutive drain failures before we surface a SystemWarning. */
const FAILURES_BEFORE_WARN = 3;

/** Operator-facing notifier (wired to pushSystemNotification at startup). */
let notifier: ((agentId: string, message: string) => void) | null = null;
export function setCodexInboundNotifier(
  fn: (agentId: string, message: string) => void,
): void {
  notifier = fn;
}

/** Format inbound the way Claude Code channels does: attributed + sender URI. */
export function formatInbound(
  senderName: string,
  fromUri: string,
  text: string,
): string {
  return `[${senderName} → you via ${fromUri}]\n${text}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class CodexController {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private threadId: string | null = null;
  private readonly queue: string[] = [];
  private draining = false;
  private connectPromise: Promise<void> | null = null;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;

  constructor(
    readonly agentId: string,
    private endpoint: string,
  ) {}

  /** Endpoint can change if the agent is respawned with a new daemon port. */
  updateEndpoint(endpoint: string): void {
    if (endpoint !== this.endpoint) {
      this.endpoint = endpoint;
      this.teardownSocket(); // reconnect against the new daemon on next use
    }
  }

  enqueue(text: string): void {
    this.queue.push(text);
    void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownSocket();
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.connectPromise = null;
    this.threadId = null;
    for (const { reject } of this.pending.values())
      reject(new Error("codex control socket closed"));
    this.pending.clear();
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
  }

  /** Re-attempt delivery after a transient failure — the poll/event model has
   *  no other self-driven retry, so without this a re-queued item could sit
   *  until the next unrelated enqueue (which may never come). */
  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer || this.queue.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, RETRY_BACKOFF_MS);
    this.retryTimer.unref?.();
  }

  private connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.endpoint);
      this.ws = ws;
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onclose = () => {
        if (this.ws === ws) this.teardownSocket();
      };
      ws.onerror = (e: unknown) => {
        if (!this.disposed)
          log(
            `${this.agentId.slice(0, 8)} control socket error:`,
            (e as { message?: string })?.message ?? "unknown",
          );
      };
      ws.onopen = async () => {
        try {
          await this.rpc("initialize", {
            clientInfo: { name: "autonomos-gateway", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          });
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
          resolve();
        } catch (err) {
          // Don't latch a rejected connectPromise — initialize failing (RPC
          // error/timeout) leaves the socket OPEN so onclose never fires, which
          // would poison every future connect(). Tear down so the next drain
          // reconnects cleanly.
          this.teardownSocket();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
    });
    return this.connectPromise;
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
        else p.resolve(msg.result);
      }
    }
    // Notifications are ignored — idle is determined by polling thread/read,
    // not by edge-triggered thread/status/changed (which we may miss).
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("codex control socket not open"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30_000);
    });
  }

  /** Discover the agent's (TUI-created) thread. The thread doesn't exist until
   *  the TUI connects, so poll — but never DROP the queue on timeout; the
   *  caller backs off and retries so messages aren't silently lost. */
  private async ensureThread(): Promise<string | null> {
    if (this.threadId) return this.threadId;
    const deadline = Date.now() + THREAD_WAIT_MS;
    while (Date.now() < deadline && !this.disposed) {
      try {
        const res = (await this.rpc("thread/loaded/list", {})) as {
          data?: string[];
        };
        const id = res?.data?.[0];
        if (id) {
          this.threadId = id;
          return id;
        }
      } catch (err) {
        // A hard RPC error (vs "no thread yet") — surface it instead of
        // burning the whole window blind, then let the caller back off.
        log(
          `${this.agentId.slice(0, 8)} thread discovery error:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
      await sleep(1_000);
    }
    return null;
  }

  /** Query ground-truth thread status. "idle" | "active" | null (unreadable). */
  private async queryIdle(threadId: string): Promise<boolean | null> {
    try {
      const r = (await this.rpc("thread/read", { threadId })) as {
        thread?: { status?: { type?: string } };
      };
      const type = r?.thread?.status?.type;
      if (type === "idle") return true;
      if (type) return false; // active / compacting / etc — not safe to inject
      return null;
    } catch {
      return null;
    }
  }

  /** Wait until the thread is confirmed idle (poll). Returns false if it never
   *  settles within the deadline or the socket becomes unreadable. */
  private async waitForIdle(threadId: string): Promise<boolean> {
    const deadline = Date.now() + IDLE_DEADLINE_MS;
    while (Date.now() < deadline && !this.disposed) {
      const idle = await this.queryIdle(threadId);
      if (idle === true) return true;
      if (idle === null) return false; // socket/daemon problem — back off
      await sleep(IDLE_POLL_MS); // active — keep waiting
    }
    return false;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed || this.queue.length === 0) return;
    this.draining = true;
    try {
      await this.connect();
      const threadId = await this.ensureThread();
      if (!threadId) {
        // No thread yet (or transient error). Keep the queue and retry — never
        // drop. Surface a warning if this keeps failing.
        this.noteFailure("waiting for the Codex session to be ready");
        this.scheduleRetry();
        return;
      }
      while (this.queue.length > 0 && !this.disposed) {
        // Poll ground truth — never inject mid-turn (it interleaves).
        const idle = await this.waitForIdle(threadId);
        if (!idle) {
          this.noteFailure("could not reach an idle window");
          this.scheduleRetry();
          return;
        }
        const next = this.queue[0]; // peek; only dequeue once delivered
        if (next === undefined) break;
        try {
          await this.rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: next }],
          });
          this.queue.shift();
          this.consecutiveFailures = 0;
          log(`${this.agentId.slice(0, 8)} injected (${next.length} chars)`);
        } catch (err) {
          // Leave the message at the queue head and retry (e.g. socket dropped).
          log(
            `${this.agentId.slice(0, 8)} turn/start failed:`,
            err instanceof Error ? err.message : err,
          );
          this.noteFailure("injection failed");
          this.scheduleRetry();
          return;
        }
      }
    } catch (err) {
      log(
        `${this.agentId.slice(0, 8)} drain error:`,
        err instanceof Error ? err.message : err,
      );
      this.noteFailure("delivery error");
      this.scheduleRetry();
    } finally {
      this.draining = false;
    }
  }

  /** Count consecutive failures; once persistent, tell the operator (the sender
   *  was already optimistically ack'd, so this is the only visible signal). */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === FAILURES_BEFORE_WARN) {
      notifier?.(
        this.agentId,
        `Inbound messages to this Codex agent aren't being delivered (${reason}). ${this.queue.length} message(s) queued.`,
      );
    }
  }
}

// ── Module-level registry ─────────────────────────────────────────────

const controllers = new Map<string, CodexController>();

/**
 * Deliver an inbound message to a Codex agent by injecting an attributed user
 * turn into its app-server daemon. Idempotent connection; queued + idle-gated.
 * Best-effort async: returns immediately; the turn lands when the agent is idle.
 */
export function deliverToCodex(
  agentId: string,
  endpoint: string,
  attributedText: string,
): void {
  let ctrl = controllers.get(agentId);
  if (!ctrl) {
    ctrl = new CodexController(agentId, endpoint);
    controllers.set(agentId, ctrl);
  } else {
    ctrl.updateEndpoint(endpoint);
  }
  ctrl.enqueue(attributedText);
}

/** Tear down a Codex agent's control client (called when the agent is killed). */
export function disposeCodexControl(agentId: string): void {
  const ctrl = controllers.get(agentId);
  if (ctrl) {
    ctrl.dispose();
    controllers.delete(agentId);
  }
}

/** For tests. */
export function _resetCodexControlForTesting(): void {
  for (const ctrl of controllers.values()) ctrl.dispose();
  controllers.clear();
  notifier = null;
}
