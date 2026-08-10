/**
 * Poll manager — one shared, visibility-gated poll per resource.
 *
 * Generalizes the pattern `useUsageQueue` proved out (the audit's one good
 * polling citizen): a module-level poll behind `useSyncExternalStore`,
 * ref-counted so it runs only while subscribed, committing a new snapshot
 * ONLY on real change so React re-renders don't churn on identical data.
 *
 * What it adds over the audit's status quo (twelve independent timers, none
 * visibility-aware, ~60-91 req/min per tab even when backgrounded):
 *
 * - VISIBILITY GATING: polling pauses while `document.visibilityState` is
 *   "hidden" and resumes with an IMMEDIATE refresh on return, so a
 *   backgrounded tab costs nothing and a foregrounded one is never stale by
 *   more than its interval.
 * - SHARED TIMERS: N components subscribing to the same poll share one timer
 *   and one in-flight request (the client core dedups the GET underneath).
 * - ERROR VISIBILITY: a failed refresh keeps the last data (no blanking) and
 *   exposes the error alongside it — the "stale is marked, not blanked"
 *   rule from the usage-correctness slice, applied dashboard-wide.
 */

import { ApiError, request } from "./core";

export interface PollState<T> {
  /** Last successful payload; null until the first success. */
  data: T | null;
  /** Error from the MOST RECENT attempt; null after any success. Data and
   * error can coexist: stale-but-shown data with a failing refresh. */
  error: ApiError | null;
}

export interface Poll<T> {
  /** `useSyncExternalStore` subscribe. First subscriber starts the timer;
   * last unsubscribe stops it. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): PollState<T>;
  /** Force a refresh now (e.g. after a mutation). Shared with pollers.
   * Deliberately NOT gated by suspension — a mutation's catch-up fetch must
   * land even while a push channel owns the cadence. */
  refresh(): Promise<void>;
  /** Suspend/resume the TIMER (push migration): while a live push channel
   * delivers this resource, the poll stops ticking; `inject` keeps the
   * snapshot current for subscribers. Resuming with subscribers fires an
   * immediate catch-up refresh, so a dropped socket degrades to exactly the
   * pre-push polling behavior with no stale window. */
  setSuspended(suspended: boolean): void;
  /** Push externally-sourced data into the snapshot as if fetched — same
   * equality/commit path, so reference stability and change-only re-renders
   * hold regardless of source. Clears any standing error. */
  inject(data: T): void;
}

interface PollOptions<T> {
  /** GET path polled; or a custom fetcher for multi-request polls. */
  source: string | (() => Promise<T>);
  intervalMs: number;
  /** Poll cadence while the tab is HIDDEN. Default 0 = fully paused (the
   * right choice for pure-display data). Set for polls that feed
   * background-critical behavior — the notifications poll drives desktop
   * notifications, which matter MOST while the user is away, so it throttles
   * (e.g. 3s → 15s) instead of pausing. Foreground cadence is never affected:
   * responsiveness while the user is looking is a hard product constraint. */
  hiddenIntervalMs?: number;
  /** Snapshot equality — defaults to JSON comparison. A `false` return
   * commits (and re-renders); keep it cheap. */
  equal?: (a: T, b: T) => boolean;
}

const jsonEqual = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

export function createPoll<T>(opts: PollOptions<T>): Poll<T> {
  const fetcher: () => Promise<T> =
    typeof opts.source === "string"
      ? () => request<T>(opts.source as string)
      : opts.source;
  const equal = opts.equal ?? jsonEqual<T>;

  let state: PollState<T> = { data: null, error: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let visListener: (() => void) | null = null;
  let suspended = false;

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: PollState<T>): void {
    const dataSame =
      state.data !== null && next.data !== null && equal(state.data, next.data);
    const errorSame =
      state.error?.message === next.error?.message &&
      state.error?.status === next.error?.status;
    if (dataSame && errorSame) return;
    // Preserve reference equality for unchanged data so selectors downstream
    // of useSyncExternalStore don't see a "new" object.
    state = { data: dataSame ? state.data : next.data, error: next.error };
    emit();
  }

  async function refresh(): Promise<void> {
    try {
      const data = await fetcher();
      commit({ data, error: null });
    } catch (err) {
      // Keep last data; surface the failure beside it.
      commit({
        data: state.data,
        error:
          err instanceof ApiError
            ? err
            : new ApiError(err instanceof Error ? err.message : String(err), 0),
      });
    }
  }

  let lastHiddenRefresh = 0;

  function tick(): void {
    if (suspended) return;
    if (document.visibilityState === "hidden") {
      // Hidden: fully paused by default; throttled for polls that feed
      // background-critical behavior (desktop notifications). The immediate
      // refresh on visibilitychange covers catch-up either way.
      const hidden = opts.hiddenIntervalMs ?? 0;
      if (hidden <= 0) return;
      const now = Date.now();
      if (now - lastHiddenRefresh < hidden) return;
      lastHiddenRefresh = now;
      void refresh();
      return;
    }
    lastHiddenRefresh = 0;
    void refresh();
  }

  function start(): void {
    if (timer) return;
    if (!suspended) void refresh();
    timer = setInterval(tick, opts.intervalMs);
    visListener = () => {
      if (document.visibilityState === "visible" && !suspended) void refresh();
    };
    document.addEventListener("visibilitychange", visListener);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (visListener) {
      document.removeEventListener("visibilitychange", visListener);
      visListener = null;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => state,
    refresh,
    setSuspended(next) {
      if (suspended === next) return;
      suspended = next;
      // Resuming while subscribed = the push channel just dropped: catch up
      // immediately so the gap between "socket died" and "first poll tick"
      // never exceeds one round-trip.
      if (!next && listeners.size > 0) void refresh();
    },
    inject(data) {
      commit({ data, error: null });
    },
  };
}
