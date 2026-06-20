/**
 * Client view of the server-side usage queue (see server `usageQueue.ts`).
 *
 * One shared poll of `GET /api/usage-queue` backs every pane's button via
 * `useSyncExternalStore` — the armed set + block status are account-wide, so a
 * single 15s poll is reused across all mounted panes (ref-counted: it starts
 * with the first subscriber and stops with the last). The server is the source
 * of truth — when it auto-fires and disarms a pane, the next poll clears that
 * pane's button with no client coordination needed.
 */

import { useCallback, useSyncExternalStore } from "react";

interface QueueSnapshot {
  armed: Set<string>;
  blocked: boolean;
  resetsAt: string | null;
}

const POLL_MS = 15_000;

let snapshot: QueueSnapshot = {
  armed: new Set(),
  blocked: false,
  resetsAt: null,
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Replace the snapshot only on a real change, so `useSyncExternalStore`
 * keeps a stable reference and avoids spurious re-renders. */
function commit(next: QueueSnapshot): void {
  if (
    sameSet(next.armed, snapshot.armed) &&
    next.blocked === snapshot.blocked &&
    next.resetsAt === snapshot.resetsAt
  ) {
    return;
  }
  snapshot = next;
  emit();
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/usage-queue").catch(() => null);
  if (!res?.ok) return;
  let data: { armed?: string[]; blocked?: boolean; resetsAt?: string | null };
  try {
    data = await res.json();
  } catch {
    return;
  }
  commit({
    armed: new Set(data.armed ?? []),
    blocked: !!data.blocked,
    resetsAt: data.resetsAt ?? null,
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  refCount += 1;
  if (!timer) {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    refCount -= 1;
    if (refCount <= 0 && timer) {
      clearInterval(timer);
      timer = null;
      refCount = 0;
    }
  };
}

function getSnapshot(): QueueSnapshot {
  return snapshot;
}

export interface UsageQueuePane {
  /** Whether this pane has an armed auto-send. */
  isArmed: boolean;
  /** Whether the account is currently usage-blocked (for the ETA hint). */
  blocked: boolean;
  /** Nearest reset timestamp while blocked, for an ETA hint (not the trigger). */
  resetsAt: string | null;
  /** Toggle this pane's armed state (optimistic, then reconciled). */
  toggle: () => Promise<void>;
}

export function useUsageQueue(sessionId: string): UsageQueuePane {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const toggle = useCallback(async () => {
    const arming = !snapshot.armed.has(sessionId);
    // Optimistic flip so the button responds instantly.
    const optimistic = new Set(snapshot.armed);
    if (arming) optimistic.add(sessionId);
    else optimistic.delete(sessionId);
    commit({ ...snapshot, armed: optimistic });

    const res = await fetch(`/api/usage-queue/${sessionId}`, {
      method: arming ? "POST" : "DELETE",
    }).catch(() => null);

    if (!res?.ok) {
      // The server never confirmed — undo the optimistic flip. Don't leave the
      // button claiming a state the server doesn't hold: if this failed because
      // the server is down, the 15s poll can't correct it either, so the lie
      // would persist for the whole outage.
      const reverted = new Set(snapshot.armed);
      if (arming) reverted.delete(sessionId);
      else reverted.add(sessionId);
      commit({ ...snapshot, armed: reverted });
      return;
    }
    // Confirmed — reconcile with server truth.
    await refresh();
  }, [sessionId]);

  return {
    isArmed: s.armed.has(sessionId),
    blocked: s.blocked,
    resetsAt: s.resetsAt,
    toggle,
  };
}
