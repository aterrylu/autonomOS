/**
 * Client view of the server-side usage queue (see server `usageQueue.ts`).
 *
 * One shared poll of `GET /api/usage-queue` backs every pane's button via
 * `useSyncExternalStore` — the armed set + per-provider caps are account-wide,
 * so a single 15s poll is reused across all mounted panes (ref-counted: starts
 * with the first subscriber, stops with the last). The server is the source of
 * truth — when it auto-fires and disarms a pane, the next poll clears that
 * pane's button with no client coordination needed.
 *
 * PER-RUNTIME (ADR-068): `caps` is keyed by provider. A pane reads ONLY its own
 * agent's provider cap, so the button renders exactly when THAT runtime is at
 * its limit — a Claude cap never lights a Codex pane, and Gemini (no cap entry)
 * never shows it. With split panes each pane resolves independently.
 *
 * The poll itself is now the shared `createPoll` manager (consolidation
 * ADR-078) rather than a bespoke timer — same 15s foreground cadence, plus the
 * visibility gating every poll gets. What createPoll deliberately does NOT own
 * is the optimistic arm/disarm flip: its state is server data, committed only
 * by a fetch. So the flip lives here as a one-field OVERLAY layered on top of
 * the poll's data, and the derived view below is memoized so
 * `useSyncExternalStore` still sees a stable reference while nothing changed.
 */

import type { UsageCapStatus, UsageQueueSnapshot } from "@autonomos/core";
import { useCallback, useSyncExternalStore } from "react";
import { usageQueueApi } from "../api/misc";
import { createPoll } from "../api/poll";

interface QueueView {
  armed: Set<string>;
  /** Per-provider cap state (e.g. "claude-code", "codex"). A provider absent
   * here is not capped / has no usage source. */
  caps: Record<string, UsageCapStatus>;
}

const POLL_MS = 15_000;

const queuePoll = createPoll<UsageQueueSnapshot>({
  source: () => usageQueueApi.snapshot(),
  intervalMs: POLL_MS,
});

/** Pending optimistic arm/disarm, shown INSTEAD of the poll's armed set until
 * the reconciling refresh lands. `null` = show server truth. */
let optimisticArmed: Set<string> | null = null;
/** Subscribers to notify when the overlay flips — poll changes are delivered
 * by the poll's own subscription, which every listener also holds. */
const overlayListeners = new Set<() => void>();

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function sameCaps(
  a: Record<string, UsageCapStatus>,
  b: Record<string, UsageCapStatus>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!b[k]) return false;
    if (
      a[k].capped !== b[k].capped ||
      a[k].resetsAt !== b[k].resetsAt ||
      a[k].window !== b[k].window
    )
      return false;
  }
  return true;
}

// Memoized derivation of (poll data + overlay) → the view components read.
// Two layers of stability, both required by useSyncExternalStore: skip the
// work when neither input moved, and keep the OLD object when the recomputed
// view is equal anyway (the poll's JSON equality can't see that a reordered
// `armed` array is the same set).
let lastData: UsageQueueSnapshot | null = null;
let lastOverlay: Set<string> | null = null;
let view: QueueView = { armed: new Set(), caps: {} };

function getSnapshot(): QueueView {
  const { data } = queuePoll.getSnapshot();
  if (data === lastData && optimisticArmed === lastOverlay) return view;
  lastData = data;
  lastOverlay = optimisticArmed;
  const armed = optimisticArmed ?? new Set(data?.armed ?? []);
  const caps = data?.caps ?? {};
  if (sameSet(armed, view.armed) && sameCaps(caps, view.caps)) return view;
  view = { armed, caps };
  return view;
}

function setOptimisticArmed(next: Set<string> | null): void {
  optimisticArmed = next;
  for (const listener of overlayListeners) listener();
}

function subscribe(listener: () => void): () => void {
  overlayListeners.add(listener);
  const unsubscribePoll = queuePoll.subscribe(listener);
  return () => {
    overlayListeners.delete(listener);
    unsubscribePoll();
  };
}

export interface UsageQueuePane {
  /** Whether this pane has an armed auto-send. */
  isArmed: boolean;
  /** Whether THIS pane's runtime is at its usage cap — the button only shows
   * when true. */
  capped: boolean;
  /** Nearest reset timestamp for this runtime, for an ETA hint (not the trigger). */
  resetsAt: string | null;
  /** Which limit is capping (server-labeled), for the button's hint. */
  capWindow: string | null;
  /** Toggle this pane's armed state (optimistic, then reconciled). */
  toggle: () => Promise<void>;
}

/**
 * @param sessionId the pane's agent id
 * @param provider the pane's agent runtime — selects which cap gates the button
 */
export function useUsageQueue(
  sessionId: string,
  provider: string,
): UsageQueuePane {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const cap = s.caps[provider];

  const toggle = useCallback(async () => {
    const current =
      optimisticArmed ?? new Set(queuePoll.getSnapshot().data?.armed ?? []);
    const arming = !current.has(sessionId);
    // Optimistic flip so the button responds instantly.
    const optimistic = new Set(current);
    if (arming) optimistic.add(sessionId);
    else optimistic.delete(sessionId);
    setOptimisticArmed(optimistic);

    try {
      if (arming) await usageQueueApi.arm(sessionId);
      else await usageQueueApi.disarm(sessionId);
    } catch {
      // The server never confirmed — drop the overlay. Don't leave the button
      // claiming a state the server doesn't hold.
      setOptimisticArmed(null);
      return;
    }
    // Confirmed — reconcile with server truth, and only THEN drop the overlay,
    // so the button never flashes its pre-toggle value in between.
    await queuePoll.refresh();
    setOptimisticArmed(null);
  }, [sessionId]);

  return {
    isArmed: s.armed.has(sessionId),
    capped: cap?.capped ?? false,
    resetsAt: cap?.resetsAt ?? null,
    capWindow: cap?.window ?? null,
    toggle,
  };
}
