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
 * full turn events (`thread/resume` → "no rollout"). It reads `thread/read`
 * for the dashboard's busy/idle STATUS only — never as a delivery gate.
 *
 * Inbound is injected IMMEDIATELY, including into a busy thread. Codex owns
 * mid-turn delivery safety: its `followup_task` contract delivers at a message
 * boundary while sampling, or after the pending tool call completes. An earlier
 * design duplicated that guarantee with an idle gate of our own, on the
 * untested assumption that a mid-turn `turn/start` would interleave and corrupt
 * the thread. Measurement refuted it, and the gate turned out to CAUSE a
 * deadlock: a thread blocked in `collaboration.wait_agent` reads as `active`,
 * so we withheld the very message that would have released it.
 *
 * The queue survives, with its job narrowed to what it is actually good for:
 * buffering across genuine TRANSPORT failures (socket down, no thread yet,
 * a turn the daemon refuses) and retrying, never dropping.
 *
 * The sender is NOT ack'd on enqueue. `deliverToCodex` returns a promise that
 * settles when THIS message reaches a terminal state: the `turn/start` reply
 * landing (delivered) or the agent being torn down (dropped). A message still
 * buffered for a transport retry settles at neither, deliberately — "still
 * trying" is not a terminal state, so the CALLER bounds its own wait and tells
 * the sender it has not landed yet.
 *
 * `turn/start` is acked by the daemon on ACCEPT, not on turn completion — an
 * injection into a thread held busy for 90s replied well inside the 30s RPC
 * deadline (the ADR-060 measurement). So awaiting the reply does not couple the
 * sender to the recipient's turn length. The caller's bound is what makes that
 * safe if a future Codex ever changes it.
 *
 * The queue still says everything out loud regardless. A queue that says nothing
 * is indistinguishable from a dropped message, which is exactly how correctly-
 * queued inbound once got reported as lost. Persistent failures also reach the
 * operator via the injected notifier.
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
 * Poll/backoff timings — transport retry/poll cadences, not delivery gates.
 * Mutable only so tests can shrink them: some of these paths back off for a
 * minute or more, and a test that cannot reach them is how the silent-drain gap
 * survived in the first place.
 * Production never calls the setter; _resetCodexControlForTesting restores it.
 */
const DEFAULT_TIMINGS = {
  /** Max time to wait for the TUI to create its thread before backing off. */
  threadWaitMs: 60_000,
  /** How often to re-ask the daemon whether the TUI has created its thread. */
  threadPollMs: 1_000,
  /** Backoff before re-attempting a drain after a transient failure. */
  retryBackoffMs: 5_000,
  /** How often the eager status watcher reconciles ground-truth status — a
   *  safety net so a missed thread/status/changed can't leave the UI stale. */
  statusPollMs: 10_000,
  /** How long inbound may be held for a REPORTED compaction before we stop
   *  believing the report and inject anyway. Real compaction ends in minutes;
   *  past this, a cached "compacting" is likelier stale than true, and an
   *  unbounded hold is a silent drop with extra steps. */
  compactingMaxHoldMs: 5 * 60_000,
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

/**
 * How an inbound message ended up, from the SENDER's point of view.
 *
 * There is deliberately no "queued" member. A message buffered for a transport
 * retry has not reached a terminal state, so it produces no result at all — the
 * caller's bounded wait expires and IT decides what to tell the sender. Adding
 * a `queued` member here would invite a caller to treat it as an outcome and
 * ack on it, which is the enqueue-is-delivery bug in a new costume.
 */
export type CodexDeliveryResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

/** One terminal outcome produced from two places — an enqueue onto an already-
 *  disposed controller, and dispose() settling the survivors. It is the same
 *  event either way, so the sender must not be able to tell which path produced
 *  it; sharing the object is what keeps the two wordings from drifting apart.
 *  Safe to share because the members are readonly. */
const TERMINATED: CodexDeliveryResult = {
  delivered: false,
  reason: "the agent was terminated",
};

/** A queued inbound message. Message TEXT is never logged (inbound can carry
 *  sensitive content); only ids, char counts and queue depth are. */
interface QueuedInbound {
  readonly text: string;
  /** Settles this message's delivery promise. Called exactly once per message
   *  in practice, and idempotent regardless — it is a `resolve`, so a second
   *  call is a no-op rather than a crash. Invoked on the `turn/start` reply
   *  (delivered) and on dispose (dropped); never on a retryable failure, which
   *  by definition has not finished. */
  readonly settle: (result: CodexDeliveryResult) => void;
}

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
  /** Next status-failure count that warrants a notification (doubles). Mirrors
   *  `nextFailureWarnAt` on the delivery path — a strict equality would warn
   *  exactly once per controller lifetime and then go silent forever. */
  private nextStatusWarnAt = FAILURES_BEFORE_WARN;
  /** Last status the daemon reported, kept for the compacting skip in drain().
   *  Fed by the same status feed the dashboard uses. A CACHED value, not ground
   *  truth: it is cleared on teardown (it describes a socket that no longer
   *  exists) and the skip that reads it is time-bounded, because a missed
   *  "compaction finished" push would otherwise pin delivery forever. */
  private lastStatus: CodexStatus | null = null;
  /** When the current compacting EPISODE was first observed; null when none is
   *  in flight. Scoped to the episode, not to a message — see below. */
  private compactingSince: number | null = null;
  /** Set once we have stopped believing a reported compaction and started
   *  injecting through it. Episode-scoped: without it, each queued message
   *  re-armed a fresh hold, so a backlog drained one message per bound (a
   *  5-deep queue = 5 waits and 5 identical notifications). The bound has to
   *  protect the QUEUE, not just its head. */
  private compactingDisbelieved = false;
  /** Why the last thread/read failed, so the status-feed log can name the
   *  cause — its only consumer since the drain stopped reading status. */
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
          this.nextStatusWarnAt = FAILURES_BEFORE_WARN; // re-arm the escalation
        }
      } catch (err) {
        // A transient hiccup self-corrects next cycle. But a PERSISTENTLY
        // unreachable daemon would silently leave the dashboard stale forever —
        // the exact failure this reconciler exists to prevent — so escalate
        // on a doubling backoff (mirrors the delivery-path warning). A strict
        // equality would fire exactly once per controller lifetime, so a daemon
        // still unreachable an hour later would have gone quiet after the first.
        if (this.disposed) return; // torn down mid-cycle — expected, not a fault
        if (++this.statusFailures >= this.nextStatusWarnAt) {
          this.nextStatusWarnAt *= 2;
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

  enqueue(text: string): Promise<CodexDeliveryResult> {
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
      return Promise.resolve(TERMINATED);
    }
    return new Promise<CodexDeliveryResult>((resolve) => {
      this.queue.push({ text, settle: resolve });
      // Log on ENQUEUE, not only on injection. Delivery is immediate now, so a
      // message sitting here means a TRANSPORT failure is being retried; without
      // this line the log
      // is byte-identical to the message having been dropped, which is exactly
      // how a correctly-queued message got reported as lost.
      log(
        `${this.agentId.slice(0, 8)} queued (${text.length} chars, queue=${this.queue.length})`,
      );
      void this.drain();
    });
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
    // Settle every survivor before clearing. A sender still inside its ack
    // window learns the outcome immediately instead of waiting out the timeout
    // for a message this line is about to destroy — and a caller that awaits
    // without a bound (a future one; the router bounds its wait) cannot be
    // parked forever by a teardown.
    for (const item of this.queue) {
      item.settle(TERMINATED);
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
    // A cached status describes the socket we are dropping. Carrying it across
    // a reconnect lets a missed "compaction finished" push hold inbound back
    // indefinitely — and we are a NON-creator, so that push is never replayed.
    // Unknown must mean unknown; the compacting skip fails open on null. Both
    // halves of that guard's state go together — a surviving `compactingSince`
    // would make a genuinely NEW compaction after the reconnect look like it
    // had already outlived the bound, firing a "status likely stale" log and
    // notification that are simply false.
    this.lastStatus = null;
    this.compactingSince = null;
    this.compactingDisbelieved = false;
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
        if (!this.disposed) {
          // `??` does not rescue an EMPTY string, and an undici ErrorEvent's
          // `message` is exactly that — its cause hangs off `.error`. So the
          // one line that names a dead daemon used to name nothing at all.
          const ev = e as { message?: string; error?: { message?: string } };
          log(
            `${this.agentId.slice(0, 8)} control socket error:`,
            ev?.message || ev?.error?.message || "unknown",
          );
        }
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
    // Notifications drive STATUS — and since the idle gate went away (ADR-060)
    // they also feed `lastStatus`, the compacting skip's only input. So a MISSED
    // "compaction finished" push CAN hold inbound back, which is exactly why
    // teardownSocket clears lastStatus and the skip is time-bounded. Do not
    // reason about this feed as purely cosmetic. The statusPollMs queryIdle
    // refresh is the other feed, and it is not guaranteed either: thread/read
    // can answer "no rollout for thread" for a non-creator client.
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
      // Leaving "compacting" is what ends an episode — not a delivered message
      // and not a timer. Reset both halves so the next real compaction gets a
      // full hold and its own single notification.
      if (mapped !== "compacting" && this.lastStatus === "compacting") {
        this.compactingSince = null;
        this.compactingDisbelieved = false;
      }
      this.lastStatus = mapped;
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

  /** Discover the agent's thread. It does not exist until the TUI has created
   *  it — observed on codex 0.144.6 to require a first turn, so an agent spawned
   *  without a starting prompt can sit here indefinitely even though its TUI
   *  attached. The "(TUI not attached?)" hint in the drain log below is
   *  therefore a guess, not a diagnosis. Poll — but never DROP the queue on timeout; the
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
   *  only act if the status-feed log names which one it was. */
  private async queryIdle(threadId: string): Promise<boolean | null> {
    try {
      const r = (await this.rpc("thread/read", { threadId })) as {
        thread?: { status?: { type?: string } };
      };
      const type = r?.thread?.status?.type;
      this.emitStatus(type);
      this.lastReadError = null;
      if (type === "idle") return true;
      if (type) return false; // a status was read, just not "idle"
      this.lastReadError = new Error(`thread status missing (type=${type})`);
      return null;
    } catch (err) {
      this.lastReadError =
        err instanceof Error ? err : new Error(String(err ?? "unknown"));
      return null;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed || this.queue.length === 0) return;
    this.draining = true;
    try {
      await this.connect();
      const threadId = await this.ensureThread();
      if (!threadId) {
        // No thread yet (or transient error) — a genuine TRANSPORT failure, and
        // the queue is doing its remaining job: buffer and retry, never drop.
        // Say so EVERY attempt; a daemon whose --remote TUI never attached sits
        // here forever, and this log is the only thing that distinguishes that
        // from a healthy agent.
        log(
          `${this.agentId.slice(0, 8)} no Codex thread yet (TUI not attached?) — ` +
            `${this.queue.length} queued, retrying`,
        );
        this.noteFailure("waiting for the Codex session to be ready");
        this.scheduleRetry();
        return;
      }
      while (this.queue.length > 0 && !this.disposed) {
        // The ONE remaining reason to hold a message back. Compaction is the
        // single thread state we did not test, so this is untested
        // conservatism, NOT a measured requirement — we determined nothing
        // about compaction, not that it is unsafe. It stays because it is
        // cheap (a window that ends on its own, and the retry picks it up)
        // while the unknown behind it is severe. Read from the status feed we
        // already maintain for the dashboard, so it costs no extra round-trip
        // on the delivery path.
        // `lastStatus` is a CACHE, so an unknown status must not be treated as
        // compacting. Refresh once when we have nothing — the only read left on
        // the delivery path, and only when the guard would otherwise be blind
        // (first delivery on a new connection).
        if (this.lastStatus === null) await this.queryIdle(threadId);
        if (this.disposed) return;
        if (this.lastStatus === "compacting" && !this.compactingDisbelieved) {
          this.compactingSince ??= Date.now();
          const heldMs = Date.now() - this.compactingSince;
          if (heldMs < timings.compactingMaxHoldMs) {
            // Log the FIRST skip of an episode only. At retryBackoffMs this
            // path repeats every few seconds; logging each one drowns the file
            // rather than signalling anything.
            if (heldMs < timings.retryBackoffMs)
              log(
                `${this.agentId.slice(0, 8)} thread is compacting — ` +
                  `${this.queue.length} queued, retrying`,
              );
            this.scheduleRetry();
            return;
          }
          // Past the bound: stop believing the status and deliver. Failing OPEN
          // matches what this skip already does when the status is unknown, and
          // it is the safe direction — the untested risk of injecting during
          // compaction is bounded, whereas holding forever is a guaranteed
          // silent drop of a message whose sender was told it would be
          // retried automatically and must NOT re-send it.
          // Latch, rather than clearing the clock: the decision is about the
          // reported STATUS, so it holds until that status actually changes.
          // Clearing here would re-arm a full hold for the next queued message.
          this.compactingDisbelieved = true;
          log(
            `${this.agentId.slice(0, 8)} still reported compacting after ` +
              `${Math.round(heldMs / 60_000)}m — status likely stale, injecting anyway`,
          );
          notifier?.(
            this.agentId,
            "Inbound to this Codex agent was held for a reported compaction that never ended — its status feed may be stale. Delivering anyway.",
          );
        }
        const next = this.queue[0]; // peek; only dequeue once delivered
        if (next === undefined) break;
        try {
          await this.rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: next.text }],
          });
          // Dequeue on the turn/start REPLY, not on send and not on the daemon
          // accepting the turn. That ordering is deliberate, and it has a known
          // cost: a dispose() landing while a reply is in flight sees a
          // non-empty queue and logs "DROPPING ... undelivered" for a message
          // that did in fact arrive. Since ADR-064 that cost is no longer only
          // cosmetic — dispose() also SETTLES that message as "the agent was
          // terminated", so the sender is told it did not land when it did.
          // Still the right direction: the settle below is a no-op once dispose
          // has resolved the promise (resolve is idempotent), the agent is being
          // torn down and will never act on the turn anyway, and the alternative
          // is claiming delivery into a process that is exiting.
          // Do NOT "fix" it by shifting earlier —
          // then any turn/start that fails after the write (socket dropped,
          // daemon died mid-call) is dropped with the log claiming delivery,
          // which is the silent-drop class #287 exists to have removed. The
          // false alarm errs toward over-reporting loss; the alternative errs
          // toward hiding it. Guarded by "keeps a rejected turn and delivers it
          // once the daemon accepts again" (codex-inbound-integration.test.ts):
          // a rejected turn is the one case where this ordering is observable,
          // and shifting earlier makes that test go red.
          this.queue.shift();
          // Settle AFTER the shift, on the same reply that authorises it. The
          // sender's ack and the dequeue therefore agree by construction: there
          // is no ordering in which we tell the sender "delivered" for a message
          // still sitting at the queue head, or shift one whose sender was told
          // it failed.
          next.settle({ delivered: true });
          this.consecutiveFailures = 0;
          this.nextFailureWarnAt = FAILURES_BEFORE_WARN;
          log(
            `${this.agentId.slice(0, 8)} injected (${next.text.length} chars)`,
          );
        } catch (err) {
          if (this.disposed) return; // teardown, not a delivery failure
          // Leave the message at the queue head and retry (e.g. socket dropped).
          //
          // KNOWN, UNFIXED: this retry can DUPLICATE. Two of the failures that
          // land here mean "we never learned the outcome", not "it failed" — an
          // RPC timeout (RPC_TIMEOUT_MS) and a teardownSocket rejecting pending
          // requests mid-flight. In both, the daemon may already have accepted
          // the turn, and the retry sends byte-identical text again, so the
          // agent can execute the same instruction twice. `turn/start` carries
          // no idempotency key and nothing daemon-side dedupes.
          //
          // Stated plainly because this PR tells SENDERS not to re-send in order
          // to avoid exactly that outcome, in five places. That instruction is
          // still right — a sender re-sending adds a second duplicate on top of
          // this one — but it must not be read as a guarantee the transport
          // provides. It does not. Reaching one needs either an idempotency
          // token on turn/start (daemon support we do not have) or treating a
          // TIMEOUT as terminal-unknown and giving up the retry, which trades
          // this duplicate risk for a silent-loss risk. That is a real design
          // call with its own measurement burden — deliberately not made here.
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

  /** Count consecutive failures; once persistent, tell the operator. Since
   *  ADR-064 the sender learns about ITS OWN message (the router's ack window
   *  expires and reports "not delivered, still retrying"), but nothing else
   *  reports an agent whose inbound is wedged across senders — this does.
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
 * turn into its app-server daemon. Idempotent connection. The turn is injected
 * right away, INCLUDING into a busy thread — Codex delivers it at its own turn
 * boundary (ADR-060). The queue behind this is a retry buffer for transport
 * failures, not a delivery gate.
 *
 * The returned promise settles only on a TERMINAL outcome — the daemon accepted
 * the turn, or the agent was torn down. It stays pending while the message is
 * buffered for a transport retry, so **every caller must bound its own wait**;
 * awaiting it unconditionally will park until the transport recovers.
 */
export function deliverToCodex(
  agentId: string,
  endpoint: string,
  attributedText: string,
): Promise<CodexDeliveryResult> {
  const ctrl = getOrCreate(agentId, endpoint);
  ctrl.watch(); // ensure status is tracked even if spawn didn't start it
  return ctrl.enqueue(attributedText);
}

/** Tear down a Codex agent's control client (called when the agent is killed). */
export function disposeCodexControl(agentId: string): void {
  const ctrl = controllers.get(agentId);
  if (ctrl) {
    ctrl.dispose();
    controllers.delete(agentId);
  }
}

/** For tests.
 *
 *  Must stay SYNCHRONOUS. It disposes every controller and restores production
 *  timings in a single tick, so no suspended `sleep()` inside a status loop can
 *  ever resume to find `disposed === false` with the long timings back. Insert
 *  a single `await` here and a torn-down loop starts holding the test runner
 *  open for a full `statusPollMs` (10s in production values) per controller. */
export function _resetCodexControlForTesting(): void {
  for (const ctrl of controllers.values()) ctrl.dispose();
  controllers.clear();
  notifier = null;
  statusSink = null;
  threadIdSink = null;
  timings = { ...DEFAULT_TIMINGS };
}
