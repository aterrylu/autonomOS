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
 * ENQUEUE; the turn lands when the agent next goes idle). Because that ack does
 * NOT mean "delivered", every step of the wait is logged — enqueue, a wait that
 * outlives queueWaitWarnMs, and each expired drain attempt. An idle-gated queue
 * that says nothing is indistinguishable from a dropped message, which is
 * exactly how correctly-queued inbound once got reported as lost. Hard,
 * persistent failures (daemon unreachable, no thread ever appears, a turn that
 * never finishes) also reach the operator via the injected notifier.
 *
 * Message TEXT is never logged — inbound can carry sensitive content, so the
 * logs carry ids, char counts and queue depth only.
 *
 * No autonomOS imports here (endpoint passed in, notifier injected) — keeps this
 * free of an import cycle with the runtime, which calls dispose() on teardown.
 */

const log = (...a: unknown[]) => console.log("[codex-inbound]", ...a);

/** Consecutive drain failures before we surface a SystemWarning. */
const FAILURES_BEFORE_WARN = 3;
/** Per-request JSON-RPC deadline. Not part of `timings` — it bounds a single
 *  round-trip to a local daemon, not a poll cadence a test needs to shrink. */
const RPC_TIMEOUT_MS = 30_000;

/**
 * Poll/backoff timings. Mutable only so tests can shrink them — the delivery
 * paths worth testing are gated behind minutes of real waiting, and a test that
 * cannot reach them is how the silent-drain gap survived in the first place.
 * Production never calls the setter; _resetCodexControlForTesting restores it.
 */
const DEFAULT_TIMINGS = {
  /** How often to re-check thread status while waiting for an idle window. */
  idlePollMs: 1_500,
  /** Max time to wait for a single in-flight turn to finish before giving up a
   *  drain pass (agents can legitimately work for many minutes). */
  idleDeadlineMs: 15 * 60_000,
  /** Max time to wait for the TUI to create its thread before backing off. */
  threadWaitMs: 60_000,
  /** How often to re-ask the daemon whether the TUI has created its thread. */
  threadPollMs: 1_000,
  /** Backoff before re-attempting a drain after a transient failure. */
  retryBackoffMs: 5_000,
  /** How long a queued message may wait before we tell the operator. Separate
   *  from idleDeadlineMs: waiting out a long turn is CORRECT (that tolerance
   *  stays 15m), but a wait this long is worth knowing about — it is the only
   *  signal that separates "queued behind a wedged turn" from "delivered".
   *  Without it the first operator-visible sign was 3 × 15m ≈ 45 minutes out. */
  queueWaitWarnMs: 5 * 60_000,
  /** How often the eager status watcher reconciles ground-truth status — a
   *  safety net so a missed thread/status/changed can't leave the UI stale. */
  statusPollMs: 10_000,
};
type Timings = typeof DEFAULT_TIMINGS;
let timings: Timings = { ...DEFAULT_TIMINGS };

/** For tests — shrink the waits so drain outcomes are reachable in ms. Seeded
 *  from DEFAULTS, not from the current values, so a test that forgets the reset
 *  can't silently inherit the previous test's timings. */
export function _setCodexTimingsForTesting(overrides: Partial<Timings>): void {
  timings = { ...DEFAULT_TIMINGS, ...overrides };
}

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

/** Human-readable duration for logs/notifications. Falls back to seconds below
 *  a minute so shrunk test timings don't print "0m". */
function fmtDuration(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)}m`
    : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** A queued inbound message. `queuedAt` exists so a long wait is reportable —
 *  message TEXT is never logged (inbound can carry sensitive content); only
 *  ids, char counts and queue depth are. */
interface QueuedInbound {
  readonly text: string;
  readonly queuedAt: number;
  /** Set once the operator has been told about this item's wait (warn once). */
  warned: boolean;
}

/** Outcome of waiting for an injectable window. Distinguishing "the turn is
 *  still running" from "we can't read the thread at all" matters: they have
 *  very different causes (a busy agent vs a dead daemon) and used to produce
 *  the same silent `return`. */
type IdleWait = "idle" | "busy" | "unreadable";

class CodexController {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private threadId: string | null = null;
  private readonly queue: QueuedInbound[] = [];
  private draining = false;
  private connectPromise: Promise<void> | null = null;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  /** Next failure count that warrants an operator notification (doubles). */
  private nextFailureWarnAt = FAILURES_BEFORE_WARN;
  private watching = false;
  private statusFailures = 0;
  /** One long-wait warning per stall episode; cleared on a successful inject. */
  private longWaitWarned = false;
  /** Why the last thread/read failed, so the drain log can name the cause. */
  private lastReadError: Error | null = null;
  /** Set once we've reported unparseable daemon frames (dedupe a firehose). */
  private framingErrorLogged = false;
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
          // queryIdle SWALLOWS read failures (returns null), so awaiting it and
          // resetting unconditionally made the escalation below unreachable for
          // the likeliest failure of all: a daemon that accepts the socket but
          // answers no thread/read. The counter reset every cycle, the status
          // froze, and the reconciler that exists to prevent exactly that said
          // nothing. Only a CONFIRMED read counts as reconciled.
          const idle = await this.queryIdle(threadId); // reads + emits status
          if (idle === null)
            throw this.lastReadError ?? new Error("thread/read failed");
          this.statusFailures = 0; // reconciled ground truth this cycle
        }
      } catch (err) {
        // A transient hiccup self-corrects next cycle. But a PERSISTENTLY
        // unreachable daemon would silently leave the dashboard stale forever —
        // the exact failure this reconciler exists to prevent — so escalate
        // once it's clearly not transient (mirrors the delivery-path warning).
        if (this.disposed) return; // torn down mid-cycle — expected, not a fault
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
      await sleep(timings.statusPollMs);
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
    // getOrCreate treats a disposed controller as absent, but deliverToCodex
    // resolves it and enqueues in separate statements — a kill landing between
    // them would otherwise print "queued" and then never speak again, the worst
    // possible log shape (a positive claim followed by silence).
    if (this.disposed) {
      log(
        `${this.agentId.slice(0, 8)} NOT queued (${text.length} chars) — agent was terminated`,
      );
      notifier?.(
        this.agentId,
        "An inbound message could not be delivered — this Codex agent was terminated.",
      );
      return;
    }
    this.queue.push({ text, queuedAt: Date.now(), warned: false });
    // Log on ENQUEUE, not only on injection. Delivery is idle-gated, so a
    // message can legitimately sit here for minutes; without this line the log
    // is byte-identical to the message having been dropped, which is exactly
    // how a correctly-queued message got reported as lost.
    log(
      `${this.agentId.slice(0, 8)} queued (${text.length} chars, queue=${this.queue.length})`,
    );
    void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.watching = false;
    // The ONLY hard drop in this module. Every other failure path is careful to
    // keep the queue and retry, so clearing it in silence here would reproduce
    // the exact symptom this file's logging exists to eliminate — "queued (N
    // chars)" followed by nothing, forever — except the message really is gone.
    // Reached on kill, delete, PTY exit and the resume-failure respawn.
    if (this.queue.length > 0) {
      log(
        `${this.agentId.slice(0, 8)} DROPPING ${this.queue.length} undelivered inbound message(s) — agent terminated`,
      );
      notifier?.(
        this.agentId,
        `${this.queue.length} inbound message(s) to this Codex agent were never delivered — ` +
          `the agent was terminated while they were queued.`,
      );
    }
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
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("codex control socket closed"));
    }
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
    }, timings.retryBackoffMs);
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
      // A Codex version that changed its framing would make every reply
      // unparseable → every RPC times out at 30s → the operator sees only
      // "thread status unreadable" with no hint that the PROTOCOL broke.
      // Report it once (a firehose of these would drown the log).
      if (!this.framingErrorLogged) {
        this.framingErrorLogged = true;
        log(
          `${this.agentId.slice(0, 8)} unparseable frame from the Codex daemon ` +
            `(${raw.length} bytes) — protocol mismatch? Further frames not logged.`,
        );
      }
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = this.takePending(msg.id);
      if (p) {
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

  /** Claim a pending RPC, disarming its timeout — each one settles exactly
   *  once, whoever gets there first (reply, timeout or socket teardown).
   *  Returns null if it was already settled. */
  private takePending(id: number) {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("codex control socket not open"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The timeout is cleared when the reply lands (see takePending) — leaving
      // it armed kept a 30s timer alive per RPC, and the status watcher issues
      // two every poll, so the process could never idle out.
      const timer = setTimeout(() => {
        if (this.takePending(id)) reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Discover the agent's (TUI-created) thread. The thread doesn't exist until
   *  the TUI connects, so poll — but never DROP the queue on timeout; the
   *  caller backs off and retries so messages aren't silently lost. */
  private async ensureThread(): Promise<string | null> {
    if (this.threadId) return this.threadId;
    const deadline = Date.now() + timings.threadWaitMs;
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
      await sleep(timings.threadPollMs);
    }
    return null;
  }

  /** Query ground-truth thread status. "idle" | "active" | null (unreadable).
   *  Also refreshes the dashboard working-status for free (this is the same read
   *  the status feed would do — piggyback it so a missed notification can't keep
   *  the status stale forever).
   *
   *  The failure CAUSE is stashed rather than discarded: "socket closed",
   *  "thread/read timed out" and "no rollout for thread" all surface as the same
   *  `null` here but have completely different remedies, and the operator can
   *  only act if the drain log names which one it was. */
  private async queryIdle(threadId: string): Promise<boolean | null> {
    try {
      const r = (await this.rpc("thread/read", { threadId })) as {
        thread?: { status?: { type?: string } };
      };
      const type = r?.thread?.status?.type;
      this.emitStatus(type);
      this.lastReadError = null;
      if (type === "idle") return true;
      if (type) return false; // active / compacting / etc — not safe to inject
      this.lastReadError = new Error(`thread status missing (type=${type})`);
      return null;
    } catch (err) {
      this.lastReadError =
        err instanceof Error ? err : new Error(String(err ?? "unknown"));
      return null;
    }
  }

  /** Wait until the thread is confirmed idle (poll). "busy" = still running at
   *  the deadline, "unreadable" = socket/daemon problem. */
  private async waitForIdle(threadId: string): Promise<IdleWait> {
    const deadline = Date.now() + timings.idleDeadlineMs;
    while (Date.now() < deadline && !this.disposed) {
      const idle = await this.queryIdle(threadId);
      if (idle === true) return "idle";
      if (idle === null) return "unreadable"; // socket/daemon problem — back off
      this.noteLongWait(); // active — keep waiting, but don't wait in silence
      await sleep(timings.idlePollMs);
    }
    return "busy";
  }

  /** Tell the operator once per STALL EPISODE when the head of the queue has
   *  been waiting behind an unfinished turn for too long. This is the signal
   *  that surfaces a WEDGED thread: the sender was ack'd on enqueue, the
   *  dashboard just shows "working" forever, and nothing else here speaks until
   *  ~45 minutes of failed drains.
   *
   *  The flag is per-CONTROLLER, not per-message, and is cleared by a successful
   *  injection. Per-message would fire again for every backlogged item the
   *  instant the stall ENDS — each one inherits an old `queuedAt`, so it trips
   *  the threshold on its first poll — burying the operator in "its current turn
   *  hasn't finished" notifications at the exact moment delivery is succeeding. */
  private noteLongWait(): void {
    const head = this.queue[0];
    if (!head || this.longWaitWarned) return;
    const waitedMs = Date.now() - head.queuedAt;
    if (waitedMs < timings.queueWaitWarnMs) return;
    this.longWaitWarned = true;
    const waited = fmtDuration(waitedMs);
    log(
      `${this.agentId.slice(0, 8)} inbound waiting ${waited} for an idle window ` +
        `(thread still active) — ${this.queue.length} queued`,
    );
    notifier?.(
      this.agentId,
      `Inbound messages to this Codex agent have been queued for ${waited} — ` +
        `its current turn hasn't finished. ${this.queue.length} message(s) waiting.`,
    );
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed || this.queue.length === 0) return;
    this.draining = true;
    try {
      await this.connect();
      const threadId = await this.ensureThread();
      if (!threadId) {
        // No thread yet (or transient error). Keep the queue and retry — never
        // drop. Say so EVERY attempt: this branch is the same shape as the
        // idle-window one below and was equally silent, and the queue-wait
        // warning can't cover it (noteLongWait only runs inside waitForIdle,
        // which we never reach without a thread). A daemon whose --remote TUI
        // never attached sits here forever.
        log(
          `${this.agentId.slice(0, 8)} no Codex thread yet (TUI not attached?) — ` +
            `${this.queue.length} queued, retrying`,
        );
        this.noteFailure("waiting for the Codex session to be ready");
        this.scheduleRetry();
        return;
      }
      while (this.queue.length > 0 && !this.disposed) {
        // Poll ground truth — never inject mid-turn (it interleaves).
        const wait = await this.waitForIdle(threadId);
        if (this.disposed) return; // torn down mid-wait; queue is already gone
        if (wait !== "idle") {
          // Previously both outcomes returned here with NO log at all, so a
          // thread that never went idle produced 15 minutes of pure silence
          // per attempt. Say which one happened, and say it every attempt.
          const busy = wait === "busy";
          const reason = busy
            ? `no idle window in ${fmtDuration(timings.idleDeadlineMs)} (thread still active)`
            : `thread status unreadable (${this.lastReadError?.message ?? "unknown"})`;
          log(
            `${this.agentId.slice(0, 8)} ${reason} — ${this.queue.length} queued, retrying`,
          );
          this.noteFailure(
            busy
              ? "could not reach an idle window"
              : "the thread status is unreadable",
          );
          this.scheduleRetry();
          return;
        }
        const next = this.queue[0]; // peek; only dequeue once delivered
        if (next === undefined) break;
        try {
          await this.rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: next.text }],
          });
          this.queue.shift();
          this.consecutiveFailures = 0;
          this.nextFailureWarnAt = FAILURES_BEFORE_WARN;
          this.longWaitWarned = false; // the stall (if any) is over — re-arm
          log(
            `${this.agentId.slice(0, 8)} injected (${next.text.length} chars)`,
          );
        } catch (err) {
          if (this.disposed) return; // teardown, not a delivery failure
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
      if (this.disposed) return; // the socket was closed BY us — expected
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
   *  was already optimistically ack'd, so this is the only visible signal).
   *
   *  Re-notifies on a doubling backoff rather than exactly once: a strict
   *  `=== FAILURES_BEFORE_WARN` meant one notification per controller LIFETIME,
   *  so an agent wedged at hour 0 produced a single warning the operator could
   *  miss, then nothing at hour 6 with a nine-deep queue — and the reported
   *  queue depth stayed frozen at whatever it was on failure #3. */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < this.nextFailureWarnAt) return;
    this.nextFailureWarnAt *= 2;
    notifier?.(
      this.agentId,
      `Inbound messages to this Codex agent aren't being delivered (${reason}). ${this.queue.length} message(s) queued.`,
    );
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
  statusSink = null;
  threadIdSink = null;
  timings = { ...DEFAULT_TIMINGS };
}
