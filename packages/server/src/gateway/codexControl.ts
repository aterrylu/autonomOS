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
/** How often the eager status watcher reconciles ground-truth status — a safety
 *  net so a missed thread/status/changed can't leave the dashboard stale. */
const STATUS_POLL_MS = 10_000;

/** Operator-facing notifier (wired to pushSystemNotification at startup). */
let notifier: ((agentId: string, message: string) => void) | null = null;
export function setCodexInboundNotifier(
  fn: (agentId: string, message: string) => void,
): void {
  notifier = fn;
}

/**
 * The subset of the dashboard's working-status vocabulary that Codex reports.
 * A closed union (rather than `string`) so the compiler enforces the contract
 * end-to-end and the gateway sink wiring needs no unchecked `as` cast. Every
 * member is a valid dashboard AgentStatus.
 */
export type CodexStatus = "working" | "idle" | "compacting";

/**
 * Working-status sink (wired to setAgentStatus at startup). Codex is otherwise
 * status-blind (no hook relay); its app-server daemon is the ground-truth source
 * (thread/status/changed = active|idle, thread/read = thread.status.type). We map
 * those to the dashboard's working-status vocabulary and push them here.
 */
let statusSink: ((agentId: string, status: CodexStatus) => void) | null = null;
export function setCodexStatusSink(
  fn: (agentId: string, status: CodexStatus) => void,
): void {
  statusSink = fn;
}

/**
 * Thread-id sink (wired to persist providerThreadId at startup). The daemon-
 * backed TUI creates the conversation thread on first connect; we capture its
 * id the moment we discover it and persist it on the agent record so a later
 * resume can reattach the conversation via `codex resume <threadId> --remote`.
 */
let threadIdSink: ((agentId: string, threadId: string) => void) | null = null;
export function setCodexThreadIdSink(
  fn: (agentId: string, threadId: string) => void,
): void {
  threadIdSink = fn;
}

/** Map a Codex thread.status.type to the dashboard's working-status vocabulary.
 *  Returns null for the transitional "notLoaded" and for missing/unreadable
 *  status — neither should overwrite a real status. An UNRECOGNIZED type (a
 *  status Codex emits that we don't yet map) is logged by the caller so a new
 *  vocabulary surfaces instead of being silently dropped. */
function mapStatus(type: string | undefined): CodexStatus | null {
  switch (type) {
    case "active":
      return "working";
    case "idle":
      return "idle";
    case "compacting":
      return "compacting";
    default:
      return null;
  }
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
  private watching = false;
  private statusFailures = 0;
  /** Codex status types we've already logged as unmapped (dedupe the warning). */
  private readonly unmappedSeen = new Set<string>();

  constructor(
    readonly agentId: string,
    private endpoint: string,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Start the eager status watcher: keep a connection open and reconcile the
   *  agent's working-status from the daemon (thread/status/changed pushes +
   *  a periodic thread/read safety net) so the dashboard shows live busy/idle
   *  from spawn, independent of any inbound traffic. Idempotent. */
  watch(): void {
    if (this.watching || this.disposed) return;
    this.watching = true;
    void this.statusLoop();
  }

  private async statusLoop(): Promise<void> {
    while (this.watching && !this.disposed) {
      try {
        await this.connect();
        const threadId = await this.ensureThread();
        if (threadId) {
          await this.queryIdle(threadId); // reads + emits status
          this.statusFailures = 0; // reconciled ground truth this cycle
        }
      } catch (err) {
        // A transient hiccup self-corrects next cycle. But a PERSISTENTLY
        // unreachable daemon would silently leave the dashboard stale forever —
        // the exact failure this reconciler exists to prevent — so escalate
        // once it's clearly not transient (mirrors the delivery-path warning).
        if (++this.statusFailures === FAILURES_BEFORE_WARN) {
          log(
            `${this.agentId.slice(0, 8)} status feed unreadable:`,
            err instanceof Error ? err.message : err,
          );
          notifier?.(
            this.agentId,
            "Live status for this Codex agent is unavailable (its app-server daemon is unreachable) — the dashboard status may be stale.",
          );
        }
      }
      await sleep(STATUS_POLL_MS);
    }
  }

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
    this.watching = false;
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
      // Settle EXACTLY once. Critically, the promise must settle on close/error
      // too — not only in onopen — or a socket that never opens (daemon died
      // mid-life, wrong port) leaves every awaiter (statusLoop, drain) parked
      // forever. A connect timeout backstops a socket that emits no event at all.
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.teardownSocket();
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => fail(new Error("codex control connect timed out")),
        30_000,
      );
      timer.unref?.();
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onclose = () => {
        if (this.ws === ws) this.teardownSocket();
        fail(new Error("codex control socket closed before ready"));
      };
      ws.onerror = (e: unknown) => {
        if (!this.disposed)
          log(
            `${this.agentId.slice(0, 8)} control socket error:`,
            (e as { message?: string })?.message ?? "unknown",
          );
        fail(new Error("codex control socket error before ready"));
      };
      ws.onopen = async () => {
        try {
          await this.rpc("initialize", {
            clientInfo: { name: "autonomos-gateway", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          });
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
          ok();
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };
    });
    return this.connectPromise;
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { status?: { type?: string } };
    };
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
      return;
    }
    // Notifications drive STATUS (cosmetic, eventually-consistent — a missed one
    // self-corrects on the next change or the queryIdle refresh). They are NOT
    // used for the idle-GATE, which polls thread/read for ground truth so a
    // dropped event can never wedge inbound delivery.
    if (msg.method === "thread/status/changed") {
      this.emitStatus(msg.params?.status?.type);
    } else if (msg.method === "thread/started") {
      this.emitStatus("idle"); // a fresh thread is idle until its first turn
    }
  }

  /** Push a mapped working-status to the dashboard (deduped by the sink). */
  private emitStatus(type: string | undefined): void {
    const mapped = mapStatus(type);
    if (mapped) {
      statusSink?.(this.agentId, mapped);
      return;
    }
    // null can mean "notLoaded"/missing (safe to ignore) OR a status type we
    // don't recognize yet (a genuinely-changed status we'd otherwise drop
    // silently). Surface the latter once so a new Codex vocabulary is visible.
    if (type && type !== "notLoaded" && !this.unmappedSeen.has(type)) {
      this.unmappedSeen.add(type);
      log(`${this.agentId.slice(0, 8)} unmapped Codex status type: ${type}`);
    }
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
          // Persist the conversation thread id so a later resume can reattach
          // it (`codex resume <id> --remote`). Fire once per discovered id.
          threadIdSink?.(this.agentId, id);
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

  /** Query ground-truth thread status. "idle" | "active" | null (unreadable).
   *  Also refreshes the dashboard working-status for free (this is the same read
   *  the status feed would do — piggyback it so a missed notification can't keep
   *  the status stale forever). */
  private async queryIdle(threadId: string): Promise<boolean | null> {
    try {
      const r = (await this.rpc("thread/read", { threadId })) as {
        thread?: { status?: { type?: string } };
      };
      const type = r?.thread?.status?.type;
      this.emitStatus(type);
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

function getOrCreate(agentId: string, endpoint: string): CodexController {
  let ctrl = controllers.get(agentId);
  // Treat a disposed predecessor as absent. On respawn (kill → spawn of the same
  // id) the old controller can be disposed by a late onExit AFTER the new spawn
  // grabbed it; reusing it would no-op watch()/enqueue() (both bail on disposed),
  // silently leaving the live agent with no status feed or inbound. Make a fresh one.
  if (!ctrl || ctrl.isDisposed) {
    ctrl = new CodexController(agentId, endpoint);
    controllers.set(agentId, ctrl);
  } else {
    ctrl.updateEndpoint(endpoint);
  }
  return ctrl;
}

/**
 * Start watching a Codex agent's working-status (busy/idle) from its app-server
 * daemon. Call at spawn so the dashboard shows live status immediately, with or
 * without inbound traffic. Idempotent; disposed via disposeCodexControl().
 */
export function startCodexStatusWatch(agentId: string, endpoint: string): void {
  getOrCreate(agentId, endpoint).watch();
}

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
  const ctrl = getOrCreate(agentId, endpoint);
  ctrl.watch(); // ensure status is tracked even if spawn didn't start it
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
