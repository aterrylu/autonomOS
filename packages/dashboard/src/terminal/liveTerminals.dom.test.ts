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
  // All four readyState constants — production code compares against
  // WebSocket.CONNECTING too; leaving it undefined makes `x !== CONNECTING`
  // vacuously false for undefined x and silently skips code under test.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
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
  resets: number;
} {
  const state = {
    disposed: false,
    resets: 0,
    scrolls: 0,
    failNextWrite: false,
  };
  const buf = { baseY: 0, viewportY: 0, getLine: () => null };
  let onScrollCb: (n: number) => void = () => {};
  let csiJHandler: ((params: number[]) => boolean) | null = null;
  const element = document.createElement("div");
  const terminal = {
    open: (parent: HTMLElement) => parent.appendChild(element),
    dispose: () => {
      state.disposed = true;
    },
    reset: () => {
      state.resets++;
    },
    attachCustomKeyEventHandler: () => {},
    parser: {
      registerCsiHandler: (
        id: { final: string },
        cb: (params: number[]) => boolean,
      ) => {
        if (id.final === "J") csiJHandler = cb;
        return { dispose: () => {} };
      },
    },
    registerLinkProvider: () => {},
    onScroll: (cb: (n: number) => void) => {
      onScrollCb = cb;
      return { dispose: () => {} };
    },
    onData: () => ({ dispose: () => {} }),
    loadAddon: () => {},
    clear: () => {},
    focus: () => {},
    selectAll: () => {},
    scrollToBottom: () => {
      state.scrolls++;
      buf.viewportY = buf.baseY;
    },
    scrollLines: () => {},
    // Honors the captured codex rebuild shape: scanning written data for the
    // ED3 wipe (\x1b[3J) drives the registered CSI handler exactly as xterm's
    // parser would, then the completion callback fires — the same ordering
    // the re-pin logic depends on.
    write: (data: string, cb?: () => void) => {
      // Parse (CSI dispatch) happens before the throw point, like xterm: an
      // Ink-bug throw can land after handlers already ran for the chunk.
      if (typeof data === "string" && data.includes("\x1b[3J"))
        csiJHandler?.([3]);
      if (state.failNextWrite) {
        state.failNextWrite = false;
        throw new Error("simulated xterm write throw");
      }
      cb?.();
    },
    cols: 80,
    rows: 24,
    options: { theme: {}, fontSize: 14, lineHeight: 1 },
    buffer: { active: buf },
    textarea: null,
  };
  const backend = {
    terminal: terminal as unknown as TerminalBackend["terminal"],
    fitAddon: { fit: () => {} } as TerminalBackend["fitAddon"],
    createWebglAddon: () => null,
    get disposed() {
      return state.disposed;
    },
    get resets() {
      return state.resets;
    },
    get scrolls() {
      return state.scrolls;
    },
    set failNextWrite(v: boolean) {
      state.failNextWrite = v;
    },
    buf,
    fireScroll: (n: number) => onScrollCb(n),
  };
  return backend as TerminalBackend & {
    disposed: boolean;
    resets: number;
    scrolls: number;
    buf: { baseY: number; viewportY: number };
    fireScroll: (n: number) => void;
  };
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
    entry.attach(container, null);
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
    entry.attach(second, null);
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

  it("session-end while ATTACHED frees the cache slot but keeps the final output until detach", () => {
    const { entry, container } = mount("s1");
    useStore.setState({
      activePane: { type: "session", id: "s1" },
    } as never);
    const switchPane = vi.fn();
    useStore.setState({ switchPane: switchPane as never });
    const ws = FakeWebSocket.instances[0];
    ws.onclose?.({ code: 4010 });
    // Slot freed immediately (the invariant) + UI routed away…
    expect(getLiveTerminal("s1")).toBeUndefined();
    expect(switchPane).toHaveBeenCalledWith(null);
    // …but the terminal DOM survives until the pane actually goes: the user
    // keeps seeing the final output while dockview prunes the dead panel.
    expect(backends[0].disposed).toBe(false);
    expect(entry.host.parentElement).toBe(container);
    // No reconnect loop for a dead session.
    expect(FakeWebSocket.instances).toHaveLength(1);
    // The pane unmounts → deferred disposal completes.
    entry.detach(container);
    expect(backends[0].disposed).toBe(true);
    expect(entry.host.parentElement).toBeNull();
  });

  it("after a deferred session-end, a visibility-driven reconnect is inert (final output survives)", () => {
    // jsdom's default visibilityState is "prerender", which would make the
    // visibility handler bail before ever reaching the code under test —
    // force "visible" so the reconnect path is genuinely armed.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const { entry, container } = mount("s1");
    FakeWebSocket.instances[0].onclose?.({ code: 4010 }); // ended, pane still up
    expect(entry.host.parentElement).toBe(container);
    // Tab becomes visible again → handleVisibility sees no OPEN socket and
    // calls connect(). Without the `ended` guard this reconnects to the dead
    // session and its onopen reset() blanks the preserved final output.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt
    expect(backends[0].disposed).toBe(false); // still showing final output
  });

  it("session-end while DETACHED disposes immediately", () => {
    const { entry, container } = mount("s1");
    entry.detach(container);
    FakeWebSocket.instances[0].onclose?.({ code: 4004 });
    expect(getLiveTerminal("s1")).toBeUndefined();
    expect(backends[0].disposed).toBe(true);
  });

  it("reconnect resets the terminal before the server's full replay (no duplicate history)", () => {
    vi.useFakeTimers();
    try {
      mount("s1");
      const ws1 = FakeWebSocket.instances[0];
      ws1.onopen?.(); // first connect: no reset — nothing to duplicate
      expect(backends[0].resets).toBe(0);
      ws1.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(1100);
      const ws2 = FakeWebSocket.instances[1];
      ws2.onopen?.(); // REconnect: buffer must be cleared before the replay
      expect(backends[0].resets).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a superseded socket's late onclose cannot start reconnect churn", () => {
    vi.useFakeTimers();
    try {
      mount("s1");
      const ws1 = FakeWebSocket.instances[0];
      ws1.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(1100);
      expect(FakeWebSocket.instances).toHaveLength(2); // healthy replacement
      // The old socket's close event lands LATE (it was mid-CLOSING when the
      // replacement connected). It must not arm another reconnect.
      ws1.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale mount's cleanup cannot detach a newer mount of the same session", () => {
    const { entry, container: oldContainer } = mount("s1");
    const newContainer = document.createElement("div");
    document.body.appendChild(newContainer);
    entry.attach(newContainer, null); // newer mount attached first
    entry.detach(oldContainer); // stale cleanup — must be a no-op
    expect(entry.host.parentElement).toBe(newContainer);
    entry.detach(newContainer); // the real owner detaches fine
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

describe("follow indicator (jump-to-latest pill)", () => {
  let backends: ReturnType<typeof makeFakeBackend>[];

  beforeEach(() => {
    backends = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
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
    useStore.setState({ fetchSessions: vi.fn() as never });
  });

  afterEach(() => {
    _disposeAllTerminals();
    _setBackendFactoryForTesting(null);
    vi.unstubAllGlobals();
  });

  function mountF(id: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const entry = acquireTerminal(id);
    if (!entry) throw new Error("null entry");
    entry.attach(container, null);
    return { entry, container, backend: backends[backends.length - 1] };
  }

  it("notifies on park + re-follow, and jumpToLatest recovers", () => {
    const { entry, backend } = mountF("f1");
    const states: boolean[] = [];
    entry.bindFollowIndicator((v) => states.push(v));
    expect(states).toEqual([false]); // fires immediately with current state
    // User parks the viewport 20 lines up (trackpad flick / Shift+PageUp).
    backend.buf.baseY = 30;
    backend.buf.viewportY = 10;
    backend.fireScroll(10);
    expect(states).toEqual([false, true]);
    // One click returns to the live tail and re-follows.
    entry.jumpToLatest();
    expect(states).toEqual([false, true, false]);
    expect(backend.scrolls).toBeGreaterThan(0);
    expect(backend.buf.viewportY).toBe(backend.buf.baseY);
  });

  it("a stale mount's detach cannot clear the newer mount's follow sink", () => {
    const { entry, container: oldContainer, backend } = mountF("f2");
    const newContainer = document.createElement("div");
    document.body.appendChild(newContainer);
    entry.attach(newContainer, null); // newer mount takes over
    const states: boolean[] = [];
    entry.bindFollowIndicator((v) => states.push(v)); // newer mount binds
    entry.detach(oldContainer); // stale cleanup — must not touch the sink
    backend.buf.baseY = 30;
    backend.fireScroll(0);
    expect(states).toEqual([false, true]); // sink still live
  });

  it("an app-initiated scrollback wipe (ED3, codex resize rebuild) re-pins a PARKED viewport to the tail", () => {
    const { entry, backend } = mountF("f4");
    const ws = FakeWebSocket.instances[0];
    const states: boolean[] = [];
    entry.bindFollowIndicator((v) => states.push(v));
    backend.buf.baseY = 91;
    backend.buf.viewportY = 49;
    backend.fireScroll(49); // parked one page up — the long-session ambient state
    expect(states).toEqual([false, true]);
    // The captured codex refocus rebuild: clear + WIPE SCROLLBACK + redraw.
    ws.onmessage?.({
      data: "\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H...rebuild...",
    });
    expect(backend.buf.viewportY).toBe(backend.buf.baseY); // landed at tail
    expect(states).toEqual([false, true, false]); // pill dismissed
  });

  it("ED3 while PINNED at bottom does nothing special", () => {
    const { entry, backend } = mountF("f5");
    const states: boolean[] = [];
    entry.bindFollowIndicator((v) => states.push(v));
    const before = backend.scrolls;
    FakeWebSocket.instances[0].onmessage?.({ data: "\x1b[2J\x1b[3J\x1b[H" });
    expect(backend.scrolls).toBe(before);
    expect(states).toEqual([false]);
  });

  it("window refocus never sends the cols-1 fake-resize pair (the codex 3J-rebuild trigger)", () => {
    const { entry } = mountF("f6");
    // Make the host measurable so handleFocus takes its active branch.
    Object.defineProperty(entry.host, "offsetWidth", {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(entry.host, "offsetHeight", {
      configurable: true,
      get: () => 600,
    });
    const ws = FakeWebSocket.instances[0];
    const sent0 = ws.sent.length;
    window.dispatchEvent(new Event("focus"));
    const resizes = ws.sent.slice(sent0).filter((d) => d.includes('"resize"'));
    // A real fit may send ONE true-size resize; the deliberate cols-1
    // perturbation (what made ratatui wipe its scrollback) must never appear.
    expect(resizes.some((d) => d.includes('"cols":79'))).toBe(false);
    expect(resizes.length).toBeLessThanOrEqual(1);
  });

  it("a write-throw after ED3 armed the re-pin does NOT leak the flag into a later frame", () => {
    const { entry, backend } = mountF("f7");
    const ws = FakeWebSocket.instances[0];
    backend.buf.baseY = 91;
    backend.buf.viewportY = 49;
    backend.fireScroll(49); // parked
    backend.failNextWrite = true;
    ws.onmessage?.({ data: "\x1b[2J\x1b[3J...partial..." }); // parse arms, write throws
    // User re-parks deliberately; a later unrelated frame must NOT yank them.
    const before = backend.scrolls;
    ws.onmessage?.({ data: "plain output\r\n" });
    expect(backend.scrolls).toBe(before);
    expect(backend.buf.viewportY).toBe(49); // still parked where they chose
  });

  it("jumpToLatest still works on a deferred-ended session (uncached, on screen)", () => {
    const { entry, backend } = mountF("f3");
    FakeWebSocket.instances[0].onclose?.({ code: 4010 }); // ended while attached
    expect(getLiveTerminal("f3")).toBeUndefined(); // slot freed → cache lookups miss
    backend.buf.baseY = 30;
    backend.buf.viewportY = 5;
    backend.fireScroll(5);
    entry.jumpToLatest(); // must act on the ENTRY, not via the cache
    expect(backend.buf.viewportY).toBe(backend.buf.baseY);
  });
});

describe("WebGL-recreate full-viewport refresh (blackout HARDENING, not a fix)", () => {
  let refreshes = 0;
  let contextLossCb: (() => void) | null = null;
  let webglDisposes = 0;

  beforeEach(() => {
    refreshes = 0;
    contextLossCb = null;
    webglDisposes = 0;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
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
      // Layer a refresh counter + a WORKING webgl fake over the shared fake.
      (b.terminal as { refresh?: (a: number, z: number) => void }).refresh =
        () => {
          refreshes++;
        };
      (b as { createWebglAddon: unknown }).createWebglAddon = () => ({
        dispose: () => {
          webglDisposes++;
        },
        onContextLoss: (cb: () => void) => {
          contextLossCb = cb;
          return { dispose: () => {} };
        },
      });
      return b;
    });
    useStore.setState({ fetchSessions: vi.fn() as never });
  });

  afterEach(() => {
    _disposeAllTerminals();
    _setBackendFactoryForTesting(null);
    vi.unstubAllGlobals();
  });

  function mountVisible(id: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const entry = acquireTerminal(id);
    if (!entry) throw new Error("null entry");
    // Context-loss rebuild is visibility-gated; make the host measurable.
    Object.defineProperty(entry.host, "offsetWidth", {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(entry.host, "offsetHeight", {
      configurable: true,
      get: () => 600,
    });
    entry.attach(container, null);
    return { entry, container };
  }

  it("ATTACH path: recreating the renderer forces one full-viewport refresh", () => {
    mountVisible("w1");
    expect(refreshes).toBe(1);
  });

  it("CONTEXT-LOSS path: the rebuild forces another full refresh", () => {
    mountVisible("w2");
    expect(refreshes).toBe(1);
    contextLossCb?.(); // GPU context died → dispose + rebuild
    expect(webglDisposes).toBeGreaterThan(0);
    expect(refreshes).toBe(2);
  });

  it("cannot fire per-frame: live output never triggers a refresh", () => {
    mountVisible("w3");
    const ws = FakeWebSocket.instances[0];
    for (let i = 0; i < 50; i++) ws.onmessage?.({ data: `line ${i}\r\n` });
    expect(refreshes).toBe(1); // still just the attach-time one
  });

  it("detach/re-attach cycle refreshes exactly once per recreation", () => {
    const { entry, container } = mountVisible("w4");
    entry.detach(container); // disposes webgl
    const c2 = document.createElement("div");
    document.body.appendChild(c2);
    entry.attach(c2, null); // recreates → one more refresh
    expect(refreshes).toBe(2);
  });
});
