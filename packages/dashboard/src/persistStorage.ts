import {
  createJSONStorage,
  type PersistStorage,
  type StorageValue,
} from "zustand/middleware";

/** Synchronous storage (localStorage). The change tracking assumes a write
 *  has landed when `setItem` returns, which an async storage would break. */
export interface SyncStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

/**
 * zustand `persist` storage that writes only when the persisted state changed.
 *
 * The default storage re-serializes the whole persisted slice (including the
 * ~80KB `projects` cache) and calls `localStorage.setItem` on EVERY store
 * update: every agent status frame, every sidebar-resize mousemove, every
 * dockview layout event. Almost none of those touch a persisted field.
 *
 * Two levels of skipping:
 *   1. Every persisted field is the same reference as last write → skip
 *      without serializing at all. Covers every update to non-persisted state.
 *      This relies on persisted fields being REPLACED, never mutated in place
 *      (see the contract at `partialize` in store.ts).
 *   2. A reference changed → serialize, but skip `setItem` when the JSON is
 *      identical (e.g. the projects poll re-delivering equal content as a new
 *      array every 30s).
 *
 * Multi-tab: the default wrote the whole slice on ANY update, so an idle
 * background tab's next status frame overwrote a setting you had just changed
 * in another tab. Now a tab writes only on a real change of its own, so the
 * most recent real change wins.
 *
 * Saving is best-effort. The default threw a failed write (e.g. quota full)
 * out of the caller's `set()`, aborting whatever that caller was doing. Here
 * the failure is logged once and the next update retries.
 *
 * Reads go through `createJSONStorage`, as the default does, so rehydration is
 * unchanged. Returns `undefined` when `getStorage` throws (as the default does)
 * or yields no usable `setItem`. The default would then throw on every `set()`
 * (e.g. Firefox with storage disabled, where `window.localStorage` is null).
 * zustand then warns on every update and persists nothing.
 */
export function changeAwareStorage<S>(
  getStorage: () => SyncStorage,
): PersistStorage<S> | undefined {
  let storage: SyncStorage;
  try {
    storage = getStorage();
  } catch {
    return undefined;
  }
  if (typeof storage?.setItem !== "function") return undefined;
  const base = createJSONStorage<S>(() => storage) as PersistStorage<S>;
  let lastState: S | null = null;
  let lastVersion: number | undefined;
  let lastJson: string | null = null;
  let warned = false;

  const forget = () => {
    lastState = null;
    lastVersion = undefined;
    lastJson = null;
  };

  return {
    // A (re)read means storage may no longer hold what this tab last wrote,
    // so the next update must not be skipped against stale tracking.
    getItem: (name) => {
      forget();
      return base.getItem(name);
    },
    setItem: (name, value: StorageValue<S>) => {
      const { state, version } = value;
      if (
        lastState !== null &&
        version === lastVersion &&
        sameFields(state, lastState)
      ) {
        return;
      }
      const json = JSON.stringify(value);
      lastState = state;
      lastVersion = version;
      if (json === lastJson) return;
      try {
        storage.setItem(name, json);
        lastJson = json;
      } catch (err) {
        // Forget, so the next update retries instead of skipping as "unchanged".
        forget();
        if (!warned) {
          warned = true;
          console.error(
            `[autonomOS] Saving dashboard state failed (${err instanceof Error ? err.name : "error"}); settings and layout won't survive a reload until storage frees up.`,
            err,
          );
        }
      }
    },
    removeItem: (name) => {
      forget();
      return base.removeItem(name);
    },
  };
}

/** Same keys, and every value the same reference. */
function sameFields<S>(a: S, b: S): boolean {
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  return ka.every(
    (k) =>
      (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k],
  );
}
