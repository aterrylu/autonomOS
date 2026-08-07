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
 */

import { useCallback, useSyncExternalStore } from "react";

interface CapStatus {
  capped: boolean;
  resetsAt: string | null;
}

interface QueueSnapshot {
  armed: Set<string>;
  /** Per-provider cap state (e.g. "claude-code", "codex"). A provider absent
   * here is not capped / has no usage source. */
  caps: Record<string, CapStatus>;
}

const POLL_MS = 15_000;

let snapshot: QueueSnapshot = { armed: new Set(), caps: {} };
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

function sameCaps(
  a: Record<string, CapStatus>,
  b: Record<string, CapStatus>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!b[k]) return false;
    if (a[k].capped !== b[k].capped || a[k].resetsAt !== b[k].resetsAt)
      return false;
  }
  return true;
}

/** Replace the snapshot only on a real change, so `useSyncExternalStore` keeps a
 * stable reference and avoids spurious re-renders. */
function commit(next: QueueSnapshot): void {
  if (
    sameSet(next.armed, snapshot.armed) &&
    sameCaps(next.caps, snapshot.caps)
  ) {
    return;
  }
  snapshot = next;
  emit();
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/usage-queue").catch(() => null);
  if (!res?.ok) return;
  let data: { armed?: string[]; caps?: Record<string, CapStatus> };
  try {
    data = await res.json();
  } catch {
    return;
  }
  commit({
    armed: new Set(data.armed ?? []),
    caps: data.caps ?? {},
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
  /** Whether THIS pane's runtime is at its usage cap — the button only shows
   * when true. */
  capped: boolean;
  /** Nearest reset timestamp for this runtime, for an ETA hint (not the trigger). */
  resetsAt: string | null;
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
      // button claiming a state the server doesn't hold.
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
    capped: cap?.capped ?? false,
    resetsAt: cap?.resetsAt ?? null,
    toggle,
  };
}
