import { useSyncExternalStore } from "react";

/**
 * A shared, coarse "now" for relative-time labels ("3m", the recency fade).
 *
 * Rows used to read `Date.now()` during render, so an age only advanced when
 * something ELSE happened to re-render the sidebar. Today that's incidental:
 * the 30s projects poll. Memoized rows (which skip unrelated re-renders), or a
 * sidebar that stops polling projects it isn't showing, would freeze every age
 * label. This clock ticks on its own.
 *
 * - One interval for every subscriber, not one per row.
 * - The snapshot is a cached number, stable between ticks, so it never causes
 *   a re-render by itself.
 * - Paused while the tab is hidden; ticks immediately on becoming visible, so
 *   ages are current the moment you look.
 * - No interval at all while nothing subscribes.
 */

export const NOW_TICK_MS = 30_000;

let now = Date.now();
/** True while nothing subscribes: `now` stopped advancing, so the next read
 *  refreshes it once (see getSnapshot). */
let stale = true;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function isHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

function start(): void {
  if (timer === null && !isHidden()) timer = setInterval(tick, NOW_TICK_MS);
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function onVisibilityChange(): void {
  if (isHidden()) {
    stop();
  } else {
    tick();
    start();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stale = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/** Refresh a stale clock ONCE, on the first read after a quiet period, so a
 *  row mounting minutes later doesn't paint an old age for a frame. Every
 *  later read in the same render returns the same value, as
 *  useSyncExternalStore requires. */
function getSnapshot(): number {
  if (stale) {
    now = Date.now();
    stale = false;
  }
  return now;
}

/** The shared coarse clock (ms). Re-renders its caller every {@link NOW_TICK_MS}
 *  while the tab is visible. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
