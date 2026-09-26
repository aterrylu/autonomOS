// @vitest-environment jsdom
// Must come first: stubs canvas + localStorage before xterm/store imports.
import "../test/setup-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsSocket } from "../api/agentsSocket";
import { restartingIds, useStore } from "../store";
import type { PaneConnection } from "./connectionWatch";
import {
  _disposeAllTerminals,
  _liveTerminalCount,
  _resetReplayMarkForTesting,
  _setBackendFactoryForTesting,
  _setTransportHealthForTesting,
  _watchdogTickForTesting,
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
  let onDataCb: (d: string) => void = () => {};
  const oscHandlers = new Map<number, (data: string) => boolean>();
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
      registerOscHandler: (ident: number, cb: (data: string) => boolean) => {
        oscHandlers.set(ident, cb);
        return { dispose: () => {} };
      },
    },
    registerLinkProvider: () => {},
    onScroll: (cb: (n: number) => void) => {
      onScrollCb = cb;
      return { dispose: () => {} };
    },
    onData: (cb: (d: string) => void) => {
      onDataCb = cb;
      return { dispose: () => {} };
    },
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
    /** Simulate the user typing into the xterm (its onData). */
    type: (d: string) => onDataCb(d),
    /** Simulate xterm PARSING an OSC sequence (e.g. the replay-end mark). */
    parseOsc: (ident: number, data = "") => oscHandlers.get(ident)?.(data),
  };
  return backend as TerminalBackend & {
    disposed: boolean;
    resets: number;
    scrolls: number;
    buf: { baseY: number; viewportY: number };
    fireScroll: (n: number) => void;
    type: (d: string) => void;
    parseOsc: (ident: number, data?: string) => boolean | undefined;
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

  it("session-end during a RESTART keeps the pane put (does not route away)", () => {
    // The 4010 here is the kill leg of a kill→attach under the same id — NOT a
    // genuine end. restartSession marks the id in restartingIds for the whole
    // flow; the onclose handler must NOT switchPane(null) then, or the user
    // drops to the empty state instead of watching the fresh PTY come up. This
    // is the actual "restart closes the pane" bug Terry hit.
    const { entry, container } = mount("s1");
    useStore.setState({
      activePane: { type: "session", id: "s1" },
    } as never);
    const switchPane = vi.fn();
    useStore.setState({ switchPane: switchPane as never });
    restartingIds.add("s1");
    try {
      FakeWebSocket.instances[0].onclose?.({ code: 4010 });
      // Slot still freed (the invariant — the dead socket must not hold a slot;
      // restartSession's reloadTerminal re-acquires a fresh one) …
      expect(getLiveTerminal("s1")).toBeUndefined();
      // … but the pane is NOT routed away: it stays on s1 for the reconnect.
      expect(switchPane).not.toHaveBeenCalled();
      // Final output survives on screen until the re-acquire replaces it.
      expect(backends[0].disposed).toBe(false);
      expect(entry.host.parentElement).toBe(container);
    } finally {
      restartingIds.delete("s1");
    }
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

  it("settled-fit consumes the recreate flag for ONE more refresh, then never again", () => {
    mountVisible("w5");
    expect(refreshes).toBe(1); // recreate-time refresh (possibly unsettled atlas)
    window.dispatchEvent(new Event("focus")); // handleFocus → applyFit succeeds
    expect(refreshes).toBe(2); // settled-path refresh consumed the flag
    window.dispatchEvent(new Event("focus"));
    expect(refreshes).toBe(2); // flag single-use — no refresh-per-fit
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

/**
 * Pane connection watch — the per-pane half of the honest connection
 * indicator. Each test drives a REAL LiveTerminal (fake backend + fake WS):
 * keystrokes via the xterm onData driver, server bytes via the socket's
 * onmessage, transport health via the test hook, the server's /io view via
 * a stubbed fetch. The rig measurements these pin: a half-open socket never
 * closes on its own; keys stranded in an abandoned socket still arrive late
 * (hence the fence + the visible count); a busy agent keeps echoing (hence
 * "total silence" as the trigger).
 */
describe("pane connection watch", () => {
  let backends: ReturnType<typeof makeFakeBackend>[];
  let states: PaneConnection[];
  let ioReply: { inputAgeMs: number | null; outputAgeMs: number | null };
  let ioStatus = 200;
  let fetchCalls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    backends = [];
    states = [];
    fetchCalls = [];
    ioReply = { inputAgeMs: 5_500, outputAgeMs: 60_000 };
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
    ioStatus = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        fetchCalls.push(String(url));
        return Promise.resolve(
          new Response(JSON.stringify(ioReply), { status: ioStatus }),
        );
      }),
    );
    _setBackendFactoryForTesting(() => {
      const b = makeFakeBackend();
      backends.push(b);
      return b;
    });
    useStore.setState({
      fetchSessions: vi.fn() as never,
      sessions: [{ id: "p1", provider: "claude-code" }] as never,
    });
    _setTransportHealthForTesting("connected");
  });

  afterEach(() => {
    _disposeAllTerminals();
    _setBackendFactoryForTesting(null);
    _setTransportHealthForTesting("connected");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount(id = "p1") {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const entry = acquireTerminal(id);
    if (!entry) throw new Error("acquire returned null");
    entry.attach(container, null);
    entry.bindConnectionIndicator((c) => states.push(c));
    const ws = () => FakeWebSocket.instances.at(-1)!;
    ws().onopen?.();
    return { entry, ws, backend: backends.at(-1)! };
  }
  const last = () => states.at(-1)!;
  // The probe's fetch → Response.text() chain resolves via stream
  // internals that fake timers freeze too (setImmediate); advancing fake
  // time asynchronously drains them. 1ms steps stay far below every timer
  // under test (the 3s probe abort, the 8s notice).
  const flush = async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
  };

  it("tags every terminal socket with a stable client id, a rising generation, and the replay-mark opt-in", () => {
    const { entry } = mount();
    const u1 = new URL(FakeWebSocket.instances[0].url);
    const g1 = Number(u1.searchParams.get("gen"));
    const client = u1.searchParams.get("client");
    expect(client).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(u1.searchParams.get("replayMark")).toBe("1");
    entry.forceReconnect();
    const u2 = new URL(FakeWebSocket.instances[1].url);
    expect(Number(u2.searchParams.get("gen"))).toBeGreaterThan(g1);
    expect(u2.searchParams.get("client")).toBe(client);
  });

  it("a RE-CREATED pane for the same session never reuses a lower generation (both reviewers' bug)", () => {
    // The server fences by session + page client id and keeps the highest
    // generation while ANY socket from it stays bound — a half-open one can
    // stay bound for hours. A per-instance counter restarting at 1 would sit
    // below that and have its healthy socket's input fenced.
    const { entry } = mount();
    entry.forceReconnect();
    entry.forceReconnect();
    const before = Number(
      new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.get("gen"),
    );
    disposeTerminal("p1"); // LRU eviction / session restart
    mount("p1");
    const after = Number(
      new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.get("gen"),
    );
    expect(after).toBeGreaterThan(before);
  });

  it("every user key the socket can't carry is counted — Esc/Ctrl+C included — never buffered for a late burst", () => {
    const { ws, backend } = mount();
    ws().readyState = FakeWebSocket.CONNECTING; // reconnecting
    backend.type("a");
    backend.type("\x1b"); // Esc — Claude Code's interrupt
    backend.type("\x03"); // Ctrl+C
    backend.type("\x1b[I"); // a focus report is not the user's keystroke
    expect(ws().sent).toEqual([]); // nothing queued for later
    ws().onopen?.();
    expect(last()).toEqual({ kind: "ok", droppedKeys: 3, exact: true });
  });

  it("an unanswered Esc arms the socket-dead check (but can never blame a silent agent)", async () => {
    const { backend } = mount();
    const t0 = Date.now();
    backend.type("\x1b"); // interrupt into a pane whose socket is dead
    ioReply = { inputAgeMs: null, outputAgeMs: 300 }; // server never got it
    vi.setSystemTime(t0 + 5_500);
    _watchdogTickForTesting(t0 + 5_500);
    await flush();
    expect(last()).toEqual({ kind: "lost", droppedKeys: 1, exact: false });
  });

  it("an Esc the server DID receive, with no output, disarms quietly (no 'not responding' for a non-printing key)", async () => {
    const { backend } = mount();
    const t0 = Date.now();
    backend.type("\x1b");
    vi.setSystemTime(t0 + 5_500);
    _watchdogTickForTesting(t0 + 5_500);
    await flush();
    expect(states.some((c) => c.kind === "silent")).toBe(false);
  });

  it("transport lost → every pane abandons its socket and counts unanswered keys; recovery reconnects and shows the notice, which then clears", () => {
    const { ws, backend } = mount();
    backend.type("x");
    backend.type("y");
    expect(ws().sent).toEqual(["x", "y"]);
    const first = ws();

    _setTransportHealthForTesting("reconnecting");
    expect(first.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // x, y were sent but never answered — they may be stranded.
    expect(last()).toEqual({ kind: "lost", droppedKeys: 2, exact: false });

    // The replacement hangs during the outage; recovery reconnects NOW.
    ws().readyState = FakeWebSocket.CONNECTING;
    _setTransportHealthForTesting("connected");
    expect(FakeWebSocket.instances).toHaveLength(3);
    ws().onopen?.();
    expect(last()).toEqual({ kind: "ok", droppedKeys: 2, exact: false });
    vi.advanceTimersByTime(8_000);
    expect(last()).toEqual({ kind: "ok", droppedKeys: 0 });
  });

  it("reconnecting → disconnected does NOT re-cut a pane that already recovered on its own (nox)", () => {
    const { ws } = mount();
    _setTransportHealthForTesting("reconnecting"); // cut: socket #2 created
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The link came back: the pane's own backoff reopened its socket while
    // /ws/agents is still waiting on its longer backoff.
    const recovered = ws();
    recovered.readyState = FakeWebSocket.OPEN;
    recovered.onopen?.();
    expect(last().kind).toBe("ok");
    const before = states.length;

    // The same outage escalates. Not a new loss for this pane.
    _setTransportHealthForTesting("disconnected");
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(recovered.closed).toBe(false);
    expect(states.slice(before).some((c) => c.kind === "lost")).toBe(false);

    // A genuinely NEW loss after recovery still cuts it.
    _setTransportHealthForTesting("connected");
    _setTransportHealthForTesting("reconnecting");
    expect(recovered.closed).toBe(true);
  });

  it("keys carried by a replacement socket that then closes are still counted (already-lost pane)", () => {
    const { ws, backend } = mount();
    _setTransportHealthForTesting("reconnecting"); // lost, socket #2 created
    ws().readyState = FakeWebSocket.OPEN; // #2 briefly carries keys…
    backend.type("q");
    backend.type("r");
    ws().readyState = FakeWebSocket.CLOSED;
    ws().onclose?.({ code: 1006 }); // …then dies
    expect(last()).toEqual({ kind: "lost", droppedKeys: 2, exact: false });
  });

  it("replies provoked by the scrollback REPLAY are dropped until the server's end-of-replay marker is PARSED; live replies after it go through", () => {
    _resetReplayMarkForTesting();
    const { ws, backend } = mount(); // mount() fires onopen → replay window
    backend.type("\x1b[?1;2c"); // xterm answering a DA1 query in the replay
    backend.type("\x1b[12;40R"); // …and a CPR
    backend.type("k"); // a real keystroke in the same window
    expect(ws().sent).toEqual(["k"]);
    // Slow replay parse (big buffer, throttled tab): still inside, no leak.
    vi.advanceTimersByTime(3_000);
    backend.type("\x1b[?1;2c");
    expect(ws().sent).toEqual(["k"]);
    // The marker is parsed → the replay is over → a LIVE app's query (a
    // fresh agent's startup probe) gets its reply immediately.
    expect(backend.parseOsc(7777)).toBe(true);
    backend.type("\x1b[?1;2c");
    expect(ws().sent).toEqual(["k", "\x1b[?1;2c"]);
  });

  it("the replay window re-arms on EVERY open, reconnects included", () => {
    const { entry, ws, backend } = mount();
    backend.parseOsc(7777);
    entry.forceReconnect();
    ws().onopen?.();
    backend.type("\x1b[?1;2c");
    expect(ws().sent).toEqual([]);
  });

  it("a server that never sends the marker: the window still closes (short cap before one has ever been seen)", () => {
    _resetReplayMarkForTesting();
    const { ws, backend } = mount();
    vi.advanceTimersByTime(5_100);
    backend.type("\x1b[?1;2c");
    expect(ws().sent).toEqual(["\x1b[?1;2c"]);
  });

  it("/io 404 (session ending, or a server without /io) stands down — no retry loop", async () => {
    const { backend } = mount();
    ioStatus = 404;
    const t0 = Date.now();
    backend.type("h");
    for (const dt of [5_500, 6_500, 12_000, 20_000]) {
      vi.setSystemTime(t0 + dt);
      _watchdogTickForTesting(t0 + dt);
      await flush();
    }
    expect(fetchCalls).toHaveLength(1);
    expect(states.some((c) => c.kind !== "ok")).toBe(false);
  });

  it("/io failing (401/5xx) backs off 5s, and after 3 failures the pane is cut loose — never an endless silent loop", async () => {
    const { backend } = mount();
    ioStatus = 500;
    const t0 = Date.now();
    backend.type("h");
    let now = t0 + 5_500;
    vi.setSystemTime(now);
    _watchdogTickForTesting(now);
    await flush();
    expect(fetchCalls).toHaveLength(1);
    // 1s later: backing off, no second request.
    now += 1_000;
    vi.setSystemTime(now);
    _watchdogTickForTesting(now);
    await flush();
    expect(fetchCalls).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      now += 5_100;
      vi.setSystemTime(now);
      _watchdogTickForTesting(now);
      await flush();
    }
    expect(fetchCalls).toHaveLength(3);
    expect(last()).toEqual({ kind: "lost", droppedKeys: 1, exact: false });
    expect(FakeWebSocket.instances).toHaveLength(2); // reconnected
  });

  it("a dropped-keys notice emitted while the pane was hidden waits to be SEEN before its 8s timer starts", () => {
    const { entry, ws, backend } = mount();
    ws().readyState = FakeWebSocket.CONNECTING;
    backend.type("a");
    entry.detach(); // user switched away
    ws().onopen?.(); // reconnects in the background
    vi.advanceTimersByTime(30_000); // long after 8s
    const seen: PaneConnection[] = [];
    entry.attach(
      document.body.appendChild(document.createElement("div")),
      null,
    );
    entry.bindConnectionIndicator((c) => seen.push(c));
    expect(seen.at(-1)).toEqual({ kind: "ok", droppedKeys: 1, exact: true }); // still there
    vi.advanceTimersByTime(8_100);
    expect(seen.at(-1)).toEqual({ kind: "ok", droppedKeys: 0 });
  });

  it("mod-key bindings go through the same accounting (no bypass of the dropped count)", () => {
    const { ws } = mount();
    ws().readyState = FakeWebSocket.CONNECTING;
    const entry = getLiveTerminal("p1")!;
    // The private input path every sender now shares.
    (entry as unknown as { sendInput(d: string): void }).sendInput("\x15");
    ws().onopen?.();
    expect(last()).toEqual({ kind: "ok", droppedKeys: 1, exact: true });
  });

  it("a byte back within 5s answers the keystroke — no probe at all", async () => {
    const { ws, backend } = mount();
    const t0 = Date.now();
    backend.type("h");
    ws().onmessage?.({ data: "h" });
    _watchdogTickForTesting(t0 + 6_000);
    await flush();
    expect(fetchCalls).toEqual([]);
  });

  it("5s of TOTAL silence with the server holding our key → 'Agent not responding' (claude-code); any byte clears it", async () => {
    const { ws, backend } = mount();
    const t0 = Date.now();
    backend.type("h");
    _watchdogTickForTesting(t0 + 4_000);
    await flush();
    expect(fetchCalls).toEqual([]); // not yet 5s
    vi.setSystemTime(t0 + 5_500);
    _watchdogTickForTesting(t0 + 5_500);
    await flush();
    expect(fetchCalls).toEqual(["/api/agents/p1/io"]);
    expect(last()).toEqual({ kind: "silent", since: t0 });
    ws().onmessage?.({ data: "late echo" });
    expect(last()).toEqual({ kind: "ok", droppedKeys: 0 });
  });

  it("the server never saw our key → the pane socket is dead: reconnect, don't blame the agent", async () => {
    const { backend } = mount();
    ioReply = { inputAgeMs: null, outputAgeMs: 300 };
    const t0 = Date.now();
    backend.type("h");
    vi.setSystemTime(t0 + 5_500);
    _watchdogTickForTesting(t0 + 5_500);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(last()).toEqual({ kind: "lost", droppedKeys: 1, exact: false });
  });

  it("an UNMEASURED provider never gets the agent-not-responding chip", async () => {
    // A provider NOT on the measured list (a hypothetical new TUI).
    useStore.setState({
      sessions: [{ id: "p1", provider: "future-tui" }] as never,
    });
    const { backend } = mount();
    const t0 = Date.now();
    backend.type("h");
    vi.setSystemTime(t0 + 5_500);
    _watchdogTickForTesting(t0 + 5_500);
    await flush();
    expect(states.some((c) => c.kind === "silent")).toBe(false);
    // …and it stops asking until the next byte re-arms it.
    _watchdogTickForTesting(t0 + 12_000);
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });

  it("no per-pane probing while the transport itself is down (the status bar owns that)", async () => {
    // The sequence that reaches this guard: transport goes stale → the pane
    // is cut loose → the PANE's own socket reopens first (it's a separate
    // socket) while the /ws/agents heartbeat is still stale. The pane is
    // "ok" and typeable, but a per-pane chip here would just repeat the
    // status bar — and a probe against an unreachable server proves nothing.
    const { ws, backend } = mount();
    _setTransportHealthForTesting("reconnecting");
    ws().onopen?.(); // pane socket back; transport still reconnecting
    expect(last().kind).toBe("ok");
    const t0 = Date.now();
    backend.type("h");
    vi.setSystemTime(t0 + 10_000);
    _watchdogTickForTesting(t0 + 10_000);
    await flush();
    expect(fetchCalls).toEqual([]);
  });

  it("a detached (hidden) pane is never probed", async () => {
    const { entry, backend } = mount();
    backend.type("h");
    entry.detach();
    _watchdogTickForTesting(Date.now() + 10_000);
    await flush();
    expect(fetchCalls).toEqual([]);
  });
});

/**
 * Acked input (revision 2 — Terry: "the gate should be when I type but the
 * server isn't receiving it"). Drives a real LiveTerminal through the
 * capability negotiation, server acks, agent echo, and every threshold on the
 * fake clock. Thresholds are 15–30× the worst healthy latency measured under
 * load (see connectionWatch.ts).
 */
describe("acked input — per-keystroke detection", () => {
  let backends: ReturnType<typeof makeFakeBackend>[];
  let states: PaneConnection[];

  beforeEach(() => {
    vi.useFakeTimers();
    backends = [];
    states = [];
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("acked mode must not probe /io"))),
    );
    _setBackendFactoryForTesting(() => {
      const b = makeFakeBackend();
      backends.push(b);
      return b;
    });
    useStore.setState({
      fetchSessions: vi.fn() as never,
      sessions: [{ id: "a1", provider: "claude-code" }] as never,
    });
    agentsSocket._applyForTests({
      type: "reconcile",
      agents: [],
      statuses: {},
    });
    _setTransportHealthForTesting("connected");
  });

  afterEach(() => {
    _disposeAllTerminals();
    _setBackendFactoryForTesting(null);
    _setTransportHealthForTesting("connected");
    agentsSocket._applyForTests({
      type: "reconcile",
      agents: [],
      statuses: {},
    });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const ACK_MARK = "autonomos-replay-end;input-ack=1";
  function mount(opts: { negotiate?: boolean } = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const entry = acquireTerminal("a1");
    if (!entry) throw new Error("acquire returned null");
    entry.attach(container, null);
    entry.bindConnectionIndicator((c) => states.push(c));
    const ws = () => FakeWebSocket.instances.at(-1)!;
    ws().onopen?.();
    const backend = backends.at(-1)!;
    if (opts.negotiate !== false) backend.parseOsc(7777, ACK_MARK);
    return { entry, ws, backend };
  }
  const last = () => states.at(-1)!;
  const tick = (ms: number) => {
    vi.advanceTimersByTime(ms);
    _watchdogTickForTesting(Date.now());
  };
  const frames = (ws: FakeWebSocket) =>
    (ws.sent as unknown[]).filter(
      (d) => d instanceof Uint8Array,
    ) as Uint8Array[];
  const seqOf = (f: Uint8Array) => new DataView(f.buffer).getUint32(1);
  const ack = (ws: FakeWebSocket, seq: number) => {
    const b = new ArrayBuffer(5);
    const v = new DataView(b);
    v.setUint8(0, 0x02);
    v.setUint32(1, seq);
    (ws.onmessage as unknown as (e: { data: ArrayBuffer }) => void)?.({
      data: b,
    });
  };

  it("sentAtMs is measured from BEFORE the socket existed, so a late onopen dispatch can't age every frame past the server's cutoff (nox)", () => {
    let now = 1_000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const entry = acquireTerminal("a1");
      if (!entry) throw new Error("acquire returned null");
      entry.attach(container, null); // socket created at t=1000
      const ws = FakeWebSocket.instances.at(-1)!;
      now = 4_000; // main thread busy: onopen dispatched 3s late
      ws.onopen?.();
      backends.at(-1)!.parseOsc(7777, ACK_MARK);
      now = 4_100;
      backends.at(-1)!.type("a");
      const f = frames(ws)[0];
      // Relative to the pre-socket zero: 3100ms, which errs toward "younger
      // than the server thinks is impossible". Anchored at onopen it would
      // read 100ms and the server would see the key as ~3s old and drop it.
      expect(new DataView(f.buffer).getUint32(5)).toBe(3_100);
    } finally {
      spy.mockRestore();
    }
  });

  it("NEGOTIATED: plain text until the server advertises input-ack; binary acked frames after", () => {
    const { ws, backend } = mount({ negotiate: false });
    backend.type("a");
    expect(ws().sent).toEqual(["a"]); // an older server: the old way
    backend.parseOsc(7777, ACK_MARK);
    backend.type("b");
    const f = frames(ws());
    expect(f).toHaveLength(1);
    expect(f[0][0]).toBe(0x01);
    expect(new TextDecoder().decode(f[0].subarray(9))).toBe("b");
    // The URL asked for it; the marker is what switched it on.
    expect(new URL(ws().url).searchParams.get("inputAck")).toBe("1");
  });

  it("a replay marker WITHOUT the ack token keeps plain text (old server)", () => {
    const { ws, backend } = mount({ negotiate: false });
    backend.parseOsc(7777, "autonomos-replay-end");
    backend.type("x");
    expect(ws().sent).toEqual(["x"]);
  });

  it("every new socket re-negotiates (no carrying ack mode across a reconnect)", () => {
    const { entry, ws, backend } = mount();
    entry.forceReconnect();
    ws().onopen?.();
    backend.type("z");
    expect(ws().sent).toEqual(["z"]); // marker not seen yet on THIS socket
  });

  it("1s without an ack → 'Not reaching server…' with the exact key count; the ack clears it", () => {
    const { ws, backend } = mount();
    backend.type("h");
    backend.type("i");
    tick(900);
    expect(last().kind).toBe("ok");
    tick(200);
    expect(last()).toEqual({ kind: "unacked", keys: 2 });
    for (const f of frames(ws())) ack(ws(), seqOf(f));
    expect(last()).toEqual({ kind: "ok", droppedKeys: 0 });
  });

  it("3s without an ack → give up: reconnect, and the notice says the keys WEREN'T sent (exact)", () => {
    const { ws, backend } = mount();
    backend.type("h");
    backend.type("i");
    tick(3_100);
    expect(last()).toEqual({ kind: "lost", droppedKeys: 2, exact: true });
    expect(FakeWebSocket.instances).toHaveLength(2);
    ws().onopen?.();
    expect(last()).toEqual({ kind: "ok", droppedKeys: 2, exact: true });
  });

  it("binary control frames are NEVER written into the terminal", () => {
    const { ws, backend } = mount();
    const writes: unknown[] = [];
    const orig = backend.terminal.write.bind(backend.terminal);
    (backend.terminal as { write: unknown }).write = (
      d: unknown,
      cb?: () => void,
    ) => {
      writes.push(d);
      orig(d as string, cb);
    };
    backend.type("h");
    ack(ws(), seqOf(frames(ws())[0]));
    expect(writes).toEqual([]);
  });

  it("acked key, no echo: subtle 'Waiting for agent…' at 2s, explicit 'Agent not responding' at 5s, echo clears", () => {
    const { ws, backend } = mount();
    backend.type("h");
    const t0 = Date.now();
    ack(ws(), seqOf(frames(ws())[0]));
    tick(1_900);
    expect(last().kind).toBe("ok");
    tick(200);
    expect(last()).toEqual({ kind: "waiting", since: t0 });
    tick(3_000);
    expect(last()).toEqual({ kind: "silent", since: t0 });
    ws().onmessage?.({ data: "h" });
    expect(last()).toEqual({ kind: "ok", droppedKeys: 0 });
  });

  it("an echo within the window means no chip at all (the healthy case: ≤67ms measured)", () => {
    const { ws, backend } = mount();
    backend.type("h");
    ack(ws(), seqOf(frames(ws())[0]));
    ws().onmessage?.({ data: "h" });
    tick(10_000);
    expect(states.every((c) => c.kind === "ok")).toBe(true);
  });

  it("no 'waiting'/'not responding' while the agent is at a permission or choice dialog (needs_input)", () => {
    agentsSocket._applyForTests({
      type: "reconcile",
      agents: [],
      statuses: {
        a1: {
          state: {
            status: "needs_input",
            lastEvent: "PermissionRequest",
            updatedAt: 1,
          },
          unread: 0,
        },
      },
    } as never);
    const { ws, backend } = mount();
    backend.type("y");
    ack(ws(), seqOf(frames(ws())[0]));
    tick(8_000);
    expect(states.every((c) => c.kind === "ok")).toBe(true);
  });

  it("an unmeasured provider never gets the agent chips (the unacked chip still applies — it's transport)", () => {
    useStore.setState({
      sessions: [{ id: "a1", provider: "future-tui" }] as never,
    });
    const { ws, backend } = mount();
    backend.type("h");
    ack(ws(), seqOf(frames(ws())[0]));
    tick(8_000);
    expect(
      states.some((c) => c.kind === "waiting" || c.kind === "silent"),
    ).toBe(false);
    backend.type("j");
    tick(1_100);
    expect(last()).toEqual({ kind: "unacked", keys: 1 });
  });

  it("mouse/focus reports and terminal replies are framed but not tracked (no false 'not reaching')", () => {
    const { backend } = mount();
    backend.type("\x1b[<0;10;5M");
    backend.type("\x1b[I");
    tick(3_500);
    expect(states.every((c) => c.kind === "ok")).toBe(true);
  });

  it("a transport loss with YOUNG unacked keys can't claim they weren't sent (exact: false)", () => {
    const { backend } = mount();
    backend.type("h");
    vi.advanceTimersByTime(300); // well before the 3s give-up
    _setTransportHealthForTesting("reconnecting");
    expect(last()).toEqual({ kind: "lost", droppedKeys: 1, exact: false });
  });

  it("acked mode never probes /io (the ack IS the receipt)", () => {
    const { ws, backend } = mount();
    backend.type("h");
    ack(ws(), seqOf(frames(ws())[0]));
    tick(9_000);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
