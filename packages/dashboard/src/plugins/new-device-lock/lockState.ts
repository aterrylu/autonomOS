// The new-device lock as the signed-in owner sees it (ADR-148): one poll of
// GET /api/auth/lock feeds the alert bar under the header, the status-bar pill
// and the bell's pinned entry, so the three can never disagree.
//
// "Hide" is remembered per LOCK, not forever: it stores the lock's `lockedAt`,
// so a later lock (a new attack after an unlock) shows the bar again.

import { create } from "zustand";
import { request } from "../../api/core";

export type LockState = {
  enabled: boolean;
  locked: boolean;
  failures: number;
  limit: number;
  lockedAt: number | null;
  lastFailureFrom: string | null;
  lastFailureAt: number | null;
  /** Behind tailscale serve: the Tailscale user of the last attempt. */
  lastFailureLogin?: string | null;
};

export function isLockState(v: unknown): v is LockState {
  const o = v as Partial<LockState> | null;
  return (
    !!o &&
    typeof o.locked === "boolean" &&
    typeof o.failures === "number" &&
    typeof o.limit === "number"
  );
}

/** Mutable so tests can shrink it. */
export const lockPollTiming = { intervalMs: 30_000 };

export const HIDDEN_KEY = "autonomos.newDeviceLock.hiddenFor";

function readHidden(): number | null {
  try {
    const v = localStorage.getItem(HIDDEN_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function writeHidden(lockedAt: number | null): void {
  try {
    if (lockedAt === null) localStorage.removeItem(HIDDEN_KEY);
    else localStorage.setItem(HIDDEN_KEY, String(lockedAt));
  } catch {
    // Private window / blocked storage: Hide lasts for this page only.
  }
}

interface LockStore {
  lock: LockState | null;
  /** The lockedAt the owner hid the bar for (null: not hidden). */
  hiddenFor: number | null;
  /** Show the Details row (the bell's Details button opens the bar on it). */
  detailsOpen: boolean;
  unlocking: boolean;
  refresh: () => Promise<void>;
  /** POST /api/auth/unlock; true when the server confirmed the lock is open. */
  unlock: () => Promise<boolean>;
  hide: () => void;
  reopen: (opts?: { details?: boolean }) => void;
  toggleDetails: () => void;
}

export const useLockStore = create<LockStore>((set, get) => ({
  lock: null,
  hiddenFor: readHidden(),
  detailsOpen: false,
  unlocking: false,
  async refresh() {
    try {
      const data = await request<unknown>("/api/auth/lock", {
        fresh: true,
        signal: AbortSignal.timeout(5_000),
      });
      // An older server has no such route (404 → throws): stays null.
      set({ lock: isLockState(data) ? data : null });
    } catch {
      // Unreachable / older server: keep what we had.
    }
  },
  async unlock() {
    set({ unlocking: true });
    try {
      const next = await request<unknown>("/api/auth/unlock", {
        method: "POST",
        body: {},
      });
      const lock = isLockState(next) ? next : null;
      set({ lock });
      return lock !== null && !lock.locked;
    } catch {
      return false;
    } finally {
      set({ unlocking: false });
    }
  },
  hide() {
    const at = get().lock?.lockedAt ?? null;
    writeHidden(at);
    set({ hiddenFor: at, detailsOpen: false });
  },
  reopen(opts) {
    writeHidden(null);
    set({ hiddenFor: null, detailsOpen: opts?.details ?? get().detailsOpen });
  },
  toggleDetails() {
    set({ detailsOpen: !get().detailsOpen });
  },
}));

/** Locked, and the owner hasn't hidden THIS lock's bar. */
export function barVisible(s: Pick<LockStore, "lock" | "hiddenFor">): boolean {
  return !!s.lock?.locked && s.hiddenFor !== s.lock.lockedAt;
}

/** Locked, and hidden: the pill takes over. */
export function pillVisible(s: Pick<LockStore, "lock" | "hiddenFor">): boolean {
  return !!s.lock?.locked && s.hiddenFor === s.lock.lockedAt;
}

/** Poll while signed in (App mounts this once). Also refreshes when the tab
 *  comes back, so an owner returning to the dashboard sees a fresh lock. */
export function startLockPoll(): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await useLockStore.getState().refresh();
    if (alive) timer = setTimeout(tick, lockPollTiming.intervalMs);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible")
      void useLockStore.getState().refresh();
  };
  void tick();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
