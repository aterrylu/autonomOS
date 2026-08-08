// @vitest-environment jsdom
// Must come first: stubs canvas + localStorage before xterm/store imports.
import "../test/setup-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import {
  _disposeAllTerminals,
  _liveTerminalCount,
  _setBackendFactoryForTesting,
  acquireTerminal,
  disposeTerminal,
  getLiveTerminal,
} from "./liveTerminals";
import type { TerminalBackend } from "./types";

/**
 * Keep-alive cache lifecycle tests. The point of the cache is the NEGATIVE
 * space: detach (pane unmount / agent switch) must NOT dispose the terminal
 * or close its WebSocket — that teardown was exactly what re-streamed the
 * whole scrollback on every switch. The fake backend + fake WS record those
 * calls so the tests can assert they DIDN'T happen.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 1; // OPEN
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function makeFakeBackend(): TerminalBackend & {
  disposed: boolean;
} {
  const state = { disposed: false };
  const element = document.createElement("div");
  const terminal = {
    open: (parent: HTMLElement) => parent.appendChild(element),
    dispose: () => {
      state.disposed = true;
    },
    attachCustomKeyEventHandler: () => {},
    registerLinkProvider: () => {},
    onScroll: () => ({ dispose: () => {} }),
    onData: () => ({ dispose: () => {} }),
    loadAddon: () => {},
    clear: () => {},
    focus: () => {},
    selectAll: () => {},
    scrollToBottom: () => {},
    scrollLines: () => {},
    write: () => {},
    cols: 80,
    rows: 24,
    options: { theme: {}, fontSize: 14, lineHeight: 1 },
    buffer: { active: { baseY: 0, viewportY: 0, getLine: () => null } },
    textarea: null,
  };
  const backend = {
    terminal: terminal as unknown as TerminalBackend["terminal"],
    fitAddon: { fit: () => {} } as TerminalBackend["fitAddon"],
    createWebglAddon: () => null,
    get disposed() {
      return state.disposed;
    },
  };
  return backend as TerminalBackend & { disposed: boolean };
}

describe("liveTerminals keep-alive cache", () => {
  let backends: ReturnType<typeof makeFakeBackend>[];

  beforeEach(() => {
    backends = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    // jsdom has no ResizeObserver; the cache's visibility logic is driven by
    // it in the browser but is not what these lifecycle tests assert.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    _setBackendFactoryForTesting(() => {
      const b = makeFakeBackend();
      backends.push(b);
      return b;
    });
    // fetchSessions would hit the network from the session-end path.
    useStore.setState({ fetchSessions: vi.fn() as never });
  });

  afterEach(() => {
    _disposeAllTerminals();
    _setBackendFactoryForTesting(null);
    vi.unstubAllGlobals();
  });

  function mount(id: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const entry = acquireTerminal(id);
    if (!entry) throw new Error("acquire returned null");
    entry.attach(container, { onClipboardCopy: null });
    return { entry, container };
  }

  it("second acquire returns the SAME live instance (no recreate on switch)", () => {
    const { entry } = mount("s1");
    entry.detach();
    const again = acquireTerminal("s1");
    expect(again).toBe(entry);
    expect(backends).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("detach keeps the terminal and its WebSocket ALIVE — the core fix", () => {
    const { entry } = mount("s1");
    const ws = FakeWebSocket.instances[0];
    entry.detach();
    expect(backends[0].disposed).toBe(false);
    expect(ws.closed).toBe(false);
    // Host left the pane but the xterm DOM survives inside it.
    expect(entry.host.parentElement).toBeNull();
    expect(entry.host.childElementCount).toBeGreaterThan(0);
  });

  it("re-attach reparents the SAME host into the new pane", () => {
    const { entry } = mount("s1");
    entry.detach();
    const second = document.createElement("div");
    document.body.appendChild(second);
    entry.attach(second, { onClipboardCopy: null });
    expect(entry.host.parentElement).toBe(second);
    expect(FakeWebSocket.instances).toHaveLength(1); // still no reconnect
  });

  it("dispose closes the WS and the terminal", () => {
    mount("s1");
    const ws = FakeWebSocket.instances[0];
    disposeTerminal("s1");
    expect(ws.closed).toBe(true);
    expect(backends[0].disposed).toBe(true);
    expect(getLiveTerminal("s1")).toBeUndefined();
  });

  it("LRU: creating a 9th terminal evicts the first-DETACHED one", () => {
    for (let i = 0; i < 8; i++) {
      const { entry } = mount(`s${i}`);
      entry.detach();
    }
    expect(_liveTerminalCount()).toBe(8);
    mount("s8");
    expect(_liveTerminalCount()).toBe(8);
    expect(getLiveTerminal("s0")).toBeUndefined(); // first detached → evicted
    expect(backends[0].disposed).toBe(true);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(getLiveTerminal("s7")).toBeDefined();
  });

  it("LRU never evicts an ATTACHED terminal", () => {
    const mounted = [];
    for (let i = 0; i < 8; i++) mounted.push(mount(`s${i}`)); // all attached
    mount("s8"); // over cap, but nothing evictable
    expect(_liveTerminalCount()).toBe(9);
    for (let i = 0; i < 9; i++) expect(getLiveTerminal(`s${i}`)).toBeDefined();
  });

  it("session-end close code disposes the cache entry and routes the UI away", () => {
    const { entry } = mount("s1");
    useStore.setState({
      activePane: { type: "session", id: "s1" },
    } as never);
    const switchPane = vi.fn();
    useStore.setState({ switchPane: switchPane as never });
    const ws = FakeWebSocket.instances[0];
    ws.onclose?.({ code: 4010 });
    expect(getLiveTerminal("s1")).toBeUndefined();
    expect(backends[0].disposed).toBe(true);
    expect(switchPane).toHaveBeenCalledWith(null);
    // No reconnect loop for a dead session.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(entry.host.parentElement).toBeNull();
  });

  it("normal close (network blip) keeps the entry and schedules a reconnect", () => {
    vi.useFakeTimers();
    try {
      mount("s1");
      const ws = FakeWebSocket.instances[0];
      ws.onclose?.({ code: 1006 });
      expect(getLiveTerminal("s1")).toBeDefined();
      vi.advanceTimersByTime(1100);
      expect(FakeWebSocket.instances).toHaveLength(2); // reconnected
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquire failure (backend throws) caches nothing and returns null", () => {
    _setBackendFactoryForTesting(() => {
      throw new Error("no canvas");
    });
    expect(acquireTerminal("bad")).toBeNull();
    expect(_liveTerminalCount()).toBe(0);
  });
});
