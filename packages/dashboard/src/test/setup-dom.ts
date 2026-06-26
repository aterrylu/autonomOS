/**
 * Shared setup for jsdom component tests (L2 layer).
 *
 * Imported at the top of every `*.dom.test.tsx` file — NOT wired as a global
 * vitest `setupFiles`, because the dashboard's other 171 tests run under the
 * default `node` environment and must stay untouched. Each component test opts
 * in via the `// @vitest-environment jsdom` docblock + this import.
 *
 * Registers `@testing-library/jest-dom` matchers (toBeInTheDocument, etc.) and
 * auto-cleans the rendered DOM between tests so renders don't leak across cases.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * In-memory localStorage shim.
 *
 * The dashboard store wraps its state in zustand's `persist` middleware, whose
 * default storage is `localStorage`. Under the node env (the other 171 tests)
 * `localStorage` is absent, so persist degrades to a no-op and `setState` is
 * fine. Under jsdom it *is* present, but jsdom's Storage implementation in this
 * toolchain doesn't expose a callable `setItem` to zustand's adapter
 * ("storage.setItem is not a function"). We install a minimal, fully-functional
 * shim so `useStore.setState(...)` — the pattern these component tests use to
 * seed state — persists cleanly instead of throwing.
 *
 * Installed at import time (before any test imports the store module), so the
 * persist middleware binds to this shim when it evaluates.
 */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
}

const memoryStorage = makeMemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: memoryStorage,
});
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage,
  });
}

/**
 * jsdom has no canvas backend. Some components transitively pull in xterm's
 * webgl addon, which probes `HTMLCanvasElement.getContext` at import — jsdom
 * throws "Not implemented" and dumps a scary (but harmless) stack. Stub it to a
 * no-op so the test output stays clean; no component under test depends on a
 * real canvas.
 */
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

afterEach(() => {
  cleanup();
});
