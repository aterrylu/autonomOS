import { isReservedChord } from "../shortcuts/registry";
import { THEMES, useStore } from "../store";
import { deduplicatedOpen } from "../utils/deduplicatedOpen";
import { hasPrimaryModifier, isMac } from "../utils/platform";
import { isDegenerate, isPlausibleFit } from "./resize";
import type {
  IFitAddon,
  ILink,
  ILinkProvider,
  IWebglAddon,
  TerminalInstance,
} from "./types";
import { createXtermBackend } from "./xterm-backend";

// ── Keep-alive terminal cache ───────────────────────────────────────────
// One live terminal (xterm instance + WebSocket + reconnect loop) per session,
// OWNED HERE rather than by the React mount. Dockview re-creates panels on
// every agent switch (the ADR-047 "accepted teardown"), which used to dispose
// the terminal and close the WS — so every switch re-streamed the entire
// scrollback from the server. Now the mount only borrows a cached terminal:
// `acquire()` reparents its host <div> into the pane and `release()` detaches
// it, while the instance, its buffer, and its socket stay alive. Switching
// back re-attaches instantly with ZERO bytes re-streamed.
//
// The WS stays open while detached — frames arrive pre-coalesced (8ms
// leading-edge window server-side) and a write to a renderer-less terminal is
// just a buffer/parser update, so a hidden busy agent costs parser CPU only.
// WebGL is disposed on detach and recreated on attach (same discipline the
// visibility path always used), so hidden terminals hold no GPU context.

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
const MAX_RETRY_DELAY = 10000;

/** Cap on live cached terminals. Each holds a scrollback buffer (10k lines)
 *  and an open WS; beyond the cap the least-recently-detached is disposed and
 *  will cold-reconnect (replay is coalesced server-side, so even that path is
 *  ~16 frames, not ~19k). Attached terminals are never evicted. */
const MAX_LIVE_TERMINALS = 8;

/** Per-mount copy-toast sink. Re-pointed on every attach; nulled on detach
 *  (the owning UI is gone). */
export type ClipboardCopySink =
  | ((info: { text: string; ok: boolean }) => void)
  | null;

const cache = new Map<string, LiveTerminal>();

// Injectable backend factory — tests swap in a fake so cache-lifecycle logic
// can be exercised under jsdom (where xterm's renderer cannot boot).
type BackendFactory = typeof createXtermBackend;
let backendFactory: BackendFactory = createXtermBackend;
export function _setBackendFactoryForTesting(f: BackendFactory | null): void {
  backendFactory = f ?? createXtermBackend;
}

// ── Terminal focus registry ─────────────────────────────────────────────
// Allows external code (sidebar click handlers) to focus a specific
// session's terminal without going through React's effect chain.

/** Cancel any in-flight focus polling before starting a new one */
let pendingFocusRaf: number | null = null;

/** Focus the terminal for a given session ID. Call from click handlers. */
export function focusTerminal(sessionId: string) {
  if (pendingFocusRaf !== null) {
    cancelAnimationFrame(pendingFocusRaf);
    pendingFocusRaf = null;
  }
  // Poll until the terminal's container is visible, then focus.
  // dockview may take 1-3 frames to mount the panel and make it visible.
  // INDEPENDENT budgets: a never-mounted pane (the ⌘K switcher can target
  // agents hidden in a collapsed hierarchy group) first has to register at
  // all (~30 frames — mount + xterm creation), and only then starts the
  // visibility wait (10 frames). Sharing one counter starved the visibility
  // poll when registration used most of it — focus silently landed on body
  // for exactly the case the registration retry was added for.
  let regAttempts = 0;
  let visAttempts = 0;
  function tryFocus() {
    pendingFocusRaf = null;
    const term = cache.get(sessionId)?.terminal;
    if (!term) {
      if (++regAttempts < 30) pendingFocusRaf = requestAnimationFrame(tryFocus);
      return;
    }
    const textarea = term.textarea;
    if (textarea && textarea.offsetParent !== null) {
      term.focus();
      return;
    }
    if (++visAttempts < 10) {
      pendingFocusRaf = requestAnimationFrame(tryFocus);
    }
  }
  pendingFocusRaf = requestAnimationFrame(tryFocus);
}

/** Borrow the live terminal for `sessionId`, creating it (and its WS) on
 *  first use. Returns null when the xterm backend cannot be constructed —
 *  the caller renders the failure state. */
export function acquireTerminal(sessionId: string): LiveTerminal | null {
  let entry = cache.get(sessionId);
  if (!entry) {
    evictIfNeeded();
    try {
      entry = new LiveTerminal(sessionId);
    } catch (err) {
      console.error("Failed to create terminal backend:", err);
      return null;
    }
    cache.set(sessionId, entry);
  }
  return entry;
}

/** Fully tear down a session's cached terminal (LRU eviction / session end /
 *  explicit cleanup). Safe to call for unknown ids. */
export function disposeTerminal(sessionId: string): void {
  cache.get(sessionId)?.dispose();
}

/** Module-private: dispose() self-removes via this (the `=== entry` guard
 *  keeps a stale instance from deleting a re-acquired id's fresh entry). */
function uncache(entry: LiveTerminal): void {
  if (cache.get(entry.sessionId) === entry) cache.delete(entry.sessionId);
}

/** Peek at a session's cached terminal WITHOUT creating one. For effects
 *  (theme sync, focus) that must never construct a terminal as a side
 *  effect. */
export function getLiveTerminal(sessionId: string): LiveTerminal | undefined {
  return cache.get(sessionId);
}

function evictIfNeeded(): void {
  if (cache.size < MAX_LIVE_TERMINALS) return;
  let oldest: LiveTerminal | null = null;
  for (const entry of cache.values()) {
    if (entry.isAttached()) continue; // never evict a visible terminal
    if (!oldest || entry.detachedAt < oldest.detachedAt) oldest = entry;
  }
  // All attached (unusual: >8 panes on screen) → allow over-cap growth.
  if (oldest) disposeTerminal(oldest.sessionId);
}

/** Test-only: cache size + reset. */
export function _liveTerminalCount(): number {
  return cache.size;
}
export function _disposeAllTerminals(): void {
  for (const id of [...cache.keys()]) disposeTerminal(id);
}

export class LiveTerminal {
  readonly sessionId: string;
  /** xterm renders into this; attach() reparents it into the pane. */
  readonly host: HTMLDivElement;
  readonly terminal: TerminalInstance;
  /** When this entry last went off-screen — the LRU eviction key. */
  detachedAt = 0;

  private onClipboardCopy: ClipboardCopySink = null;
  private readonly fitAddon: IFitAddon;
  private readonly createWebglAddon: () => IWebglAddon | null;
  private webglAddon: IWebglAddon | null = null;
  /** Ref-shaped so handleKeyEvent keeps its React-era signature. */
  private readonly wsRef: { current: WebSocket | null } = { current: null };
  private disposed = false;
  private attachedTo: HTMLElement | null = null;
  /** Session ended (4010/4004) while attached — full disposal is deferred to
   *  detach() so the final output stays visible until the pane goes away. */
  private ended = false;
  /** Whether a socket ever reached onopen — a later onopen is a REconnect,
   *  whose full-buffer replay must not append a duplicate history. */
  private everConnected = false;
  /** Consecutive closes without a successful open — breadcrumb counter. */
  private consecutiveDrops = 0;

  private userScrolledUp = false;
  private programmaticScroll = false;
  private retryDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private inertiaRaf: number | null = null;
  // Assigned in installLifecycle() (the constructor tail); left undefined
  // only when construction failed partway — the rollback catch guards reads.
  private resizeObserver?: ResizeObserver;
  private handleVisibility?: () => void;
  private handleFocus?: () => void;

  // Last host box we actually fit to — lets us skip redundant fits (a
  // ResizeObserver can fire without a real dimension change), which is what
  // bakes sub-pixel cell-measurement drift into a stepwise shrink. Reset to 0
  // to force the next fit (e.g. after an implausible mis-measure).
  private lastFitW = 0;
  private lastFitH = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;

    this.host = document.createElement("div");
    this.host.style.width = "100%";
    this.host.style.height = "100%";

    const backend = backendFactory(
      {
        cursorBlink: true,
        fontSize: 14,
        fontFamily:
          '"Berkeley Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
        theme: THEMES[useStore.getState().theme].terminal,
        scrollback: 10000,
      },
      (info) => this.onClipboardCopy?.(info),
    );
    this.terminal = backend.terminal;
    this.fitAddon = backend.fitAddon;
    this.createWebglAddon = backend.createWebglAddon;

    try {
      this.terminal.open(this.host);
    } catch (err) {
      this.terminal.dispose();
      throw err;
    }

    // Everything below installs per-SESSION resources (document/window
    // listeners, a ResizeObserver, the WebSocket). A throw partway through
    // must roll them back here — the entry never enters the cache, so
    // dispose() would be unreachable and the listeners would leak forever
    // (and the leaked visibility handler could even reconnect the orphan).
    try {
      this.installLifecycle();
    } catch (err) {
      if (this.handleVisibility)
        document.removeEventListener("visibilitychange", this.handleVisibility);
      if (this.handleFocus)
        window.removeEventListener("focus", this.handleFocus);
      this.resizeObserver?.disconnect();
      this.wsRef.current?.close();
      this.wsRef.current = null;
      this.terminal.dispose();
      throw err;
    }
  }

  /** Constructor tail — split out solely so the rollback catch above can
   *  wrap it without indenting 100 lines. Runs exactly once. */
  private installLifecycle(): void {
    this.terminal.attachCustomKeyEventHandler((event) =>
      handleKeyEvent(event, this.terminal, this.wsRef),
    );
    this.terminal.registerLinkProvider(new UrlLinkProvider(this.terminal));
    // xterm.js handles OSC 8 hyperlinks via the linkHandler constructor
    // option in xterm-backend.ts (Ctrl/Cmd+Click gated).

    this.terminal.onScroll(() => {
      if (this.disposed || this.programmaticScroll) return;
      const buf = this.terminal.buffer.active;
      const atBottom = buf.baseY - buf.viewportY <= 1;
      this.userScrolledUp = !atBottom;
    });

    this.terminal.onData((data) => {
      if (this.wsRef.current?.readyState === WebSocket.OPEN) {
        this.wsRef.current.send(data);
      }
    });

    this.handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        this.wsRef.current?.readyState !== WebSocket.OPEN &&
        this.wsRef.current?.readyState !== WebSocket.CONNECTING
      ) {
        this.retryDelay = 1000;
        this.connect();
      }
    };
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.handleFocus = () => {
      if (this.disposed) return;
      if (
        this.isHostVisible() &&
        this.wsRef.current?.readyState === WebSocket.OPEN
      ) {
        // Re-fit (plausibility-guarded) to correct any stale size taken while
        // unfocused, then nudge for a repaint. Only nudge on a PLAUSIBLE fit —
        // nudgeResize is guarded solely by isDegenerate, so nudging after a
        // failed fit could ship a mis-measured size to the PTY for a frame.
        // If the renderer isn't settled, scheduleFit retries instead.
        if (this.applyFit()) {
          if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
          this.nudgeTimer = nudgeResize(this.wsRef.current, this.terminal);
        } else {
          this.scheduleFit();
        }
      }
    };
    window.addEventListener("focus", this.handleFocus);

    this.resizeObserver = new ResizeObserver(() => {
      const isVisible = this.isHostVisible();

      // Dispose WebGL when hidden to free GPU context for the active terminal
      if (!isVisible) {
        if (this.webglAddon) {
          this.webglAddon.dispose();
          this.webglAddon = null;
        }
        return;
      }

      // Load WebGL when becoming visible (GPU rendering for xterm.js)
      const hadAddon = !!this.webglAddon;
      this.loadWebglAddon();

      const w = this.host.offsetWidth;
      const h = this.host.offsetHeight;
      if (!hadAddon && this.webglAddon) {
        // Just (re)created the renderer this tick — it hasn't measured its
        // cell yet, so fit on a settled frame (scheduleFit retries until the
        // fit is plausible) rather than synchronously against a stale cell.
        this.scheduleFit();
      } else if (w !== this.lastFitW || h !== this.lastFitH) {
        // Box actually changed — fit now; if the renderer looks unsettled,
        // applyFit invalidates the cache and scheduleFit retries next frame.
        if (!this.applyFit()) this.scheduleFit();
      }
    });
    this.resizeObserver.observe(this.host);

    this.installTouchScroll();
    this.connect();
  }

  isAttached(): boolean {
    return this.attachedTo !== null;
  }

  /** Reparent the live terminal into a mounted pane. */
  attach(container: HTMLElement, onClipboardCopy: ClipboardCopySink): void {
    if (this.disposed) return;
    this.attachedTo = container;
    this.onClipboardCopy = onClipboardCopy;
    container.appendChild(this.host);
    // Theme may have changed while this terminal sat detached.
    this.terminal.options.theme = THEMES[useStore.getState().theme].terminal;
    this.loadWebglAddon();
    this.scheduleFit();
    // The buffer may have advanced while hidden; keep the tail pinned unless
    // the user had scrolled up (same rule the live stream follows).
    if (!this.userScrolledUp) {
      this.programmaticScroll = true;
      this.terminal.scrollToBottom();
      this.programmaticScroll = false;
    }
  }

  /** Take the terminal off-screen but KEEP it alive (buffer, WS, parser).
   *  The host element is removed from the pane; WebGL is released.
   *
   *  `container` is the mount asking to detach: dockview can create the NEW
   *  panel's mount before the old panel's React cleanup runs, and a stale
   *  cleanup must not rip the host out of the newer pane. Pass the mount's
   *  own container; a mismatch is a no-op. Omit only from dispose(), which
   *  detaches unconditionally. */
  detach(container?: HTMLElement): void {
    if (this.attachedTo === null) return;
    if (container !== undefined && this.attachedTo !== container) return;
    this.attachedTo = null;
    this.detachedAt = Date.now();
    this.onClipboardCopy = null;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.webglAddon) {
      this.webglAddon.dispose();
      this.webglAddon = null;
    }
    this.host.remove();
    // Deferred session-end: the PTY died while this pane was showing the
    // final output; teardown waited so the user kept seeing it. Finish now.
    if (this.ended && !this.disposed) this.dispose();
  }

  /** Full teardown — removes itself from the cache, so it is safe to call
   *  from anywhere (LRU eviction, session-end close code, tests). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    uncache(this);
    this.detach();
    if (this.inertiaRaf !== null) cancelAnimationFrame(this.inertiaRaf);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    if (this.handleVisibility)
      document.removeEventListener("visibilitychange", this.handleVisibility);
    if (this.handleFocus) window.removeEventListener("focus", this.handleFocus);
    this.resizeObserver?.disconnect();
    this.wsRef.current?.close();
    this.wsRef.current = null;
    this.terminal.dispose();
  }

  /** The session is gone server-side (4010/4004). Free the cache slot and
   *  stop all retry machinery immediately — but if a pane is still showing
   *  this terminal, keep the DOM (and the instance) alive until that pane's
   *  detach(), so the final output (last prompt, build summary) stays visible
   *  until dockview prunes the dead panel. */
  private endSession(): void {
    this.wsRef.current = null; // already closed; never reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.isAttached()) {
      this.ended = true;
      uncache(this);
    } else {
      this.dispose();
    }
  }

  private isHostVisible(): boolean {
    return this.host.offsetWidth > 0 && this.host.offsetHeight > 0;
  }

  private setStatusIfActive(status: string): void {
    const { activePane, setStatus } = useStore.getState();
    if (activePane?.type === "session" && activePane.id === this.sessionId) {
      setStatus(status);
    }
  }

  private connect(): void {
    // `ended` too, not just `disposed`: after a deferred session-end the
    // instance is intentionally alive (final output on screen) — a
    // visibilitychange-driven reconnect to the dead session would reach
    // onopen before the server's 4004 close, and its reset() would blank
    // exactly the output the deferral preserves.
    if (this.disposed || this.ended) return;
    this.userScrolledUp = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.wsRef.current?.close();

    const ws = new WebSocket(`${WS_URL}/ws/terminal/${this.sessionId}`);

    ws.onopen = () => {
      // Superseded-socket guard: connect() may replace this socket before its
      // events land; a stale socket must never act on the live state.
      if (this.wsRef.current !== ws || this.disposed) return;
      this.retryDelay = 1000;
      this.consecutiveDrops = 0;
      // The server replays the FULL scrollback on every connect. On a
      // REconnect (sleep/wake, network blip, server restart) the terminal
      // still holds that history — without a reset the replay would append a
      // duplicate copy, and since this instance now outlives mounts the
      // duplication would be permanent and cumulative.
      if (this.everConnected) this.terminal.reset();
      this.everConnected = true;
      this.setStatusIfActive(`connected: ${this.sessionId.slice(0, 8)}`);
      // Nudge only when attached — a detached terminal has nothing to
      // repaint, and the fresh fit on attach() supersedes any stale size.
      if (document.hasFocus() && this.isAttached()) {
        this.nudgeTimer = nudgeResize(ws, this.terminal);
      }
    };

    ws.onmessage = (event) => {
      if (this.wsRef.current !== ws || this.disposed) return;
      try {
        this.terminal.write(event.data);
      } catch (err) {
        // xterm.js v6.0.0 has a bug in its DECRQM ($p) handler that throws
        // on certain escape sequences emitted by Ink (used by Claude Code).
        // An uncaught throw mid-write freezes the terminal — isolate it here
        // so the next chunk still renders.
        console.warn("terminal.write() threw, continuing:", err);
      }
      if (!this.userScrolledUp) {
        if (this.scrollTimer) clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => {
          this.programmaticScroll = true;
          this.terminal.scrollToBottom();
          this.programmaticScroll = false;
        }, 100);
      }
    };

    ws.onclose = (event) => {
      // A superseded socket's close must not schedule a reconnect — that was
      // the churn loop: stale onclose arms a timer that closes the healthy
      // replacement, whose onclose arms the next, forever.
      if (this.wsRef.current !== ws || this.disposed) return;
      if (event.code === 4010 || event.code === 4004) {
        // Session ended / not found — this terminal has no future. Drop the
        // cache entry FIRST (the invariant: a dead session must not hold a
        // keep-alive slot or a reconnect loop — a throw in the store calls
        // below must not leave a zombie), then route the UI away.
        this.endSession();
        const store = useStore.getState();
        const { activePane } = store;
        if (
          activePane?.type === "session" &&
          activePane.id === this.sessionId
        ) {
          store.switchPane(null);
        }
        store.fetchSessions();
        return;
      }
      this.consecutiveDrops++;
      if (this.consecutiveDrops > 0 && this.consecutiveDrops % 10 === 0) {
        // A detached cached terminal retries invisibly — leave a breadcrumb
        // so sustained failure (bad proxy, expired upgrade) is diagnosable.
        console.warn(
          `[terminal] session ${this.sessionId.slice(0, 8)}: ` +
            `${this.consecutiveDrops} consecutive WS drops, still retrying (delay ${this.retryDelay}ms)`,
        );
      }
      this.setStatusIfActive("reconnecting...");
      this.reconnectTimer = setTimeout(() => {
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY);
        this.connect();
      }, this.retryDelay);
    };
    ws.onerror = (event) => {
      console.warn(`WebSocket error for session ${this.sessionId}:`, event);
    };

    this.wsRef.current = ws;
  }

  // Fit the terminal to its host and push the size to the PTY — but ONLY if
  // the fit produced a PLAUSIBLE geometry. A freshly (re)created WebGL
  // renderer may not have measured its character cell yet, so fit() can
  // compute a wildly-too-small cols/rows (isPlausibleFit's headline case).
  // isDegenerate alone only blocks the 2×1 floor, so such a mis-measure would
  // otherwise reach the PTY and wedge the remote tty until a manual refresh
  // (the idle self-shrink). On an implausible fit we skip the send, invalidate
  // the cache (so a later box change still retries), and let scheduleFit retry
  // on a settled frame. Returns true once applied.
  private applyFit(): boolean {
    if (this.disposed || !this.isHostVisible()) return false;
    try {
      this.fitAddon.fit();
    } catch (err) {
      console.warn("fitAddon.fit() failed:", err);
      return false;
    }
    const w = this.host.offsetWidth;
    const h = this.host.offsetHeight;
    if (!isPlausibleFit(this.terminal.cols, this.terminal.rows, w, h)) {
      this.lastFitW = 0;
      this.lastFitH = 0;
      return false;
    }
    this.lastFitW = w;
    this.lastFitH = h;
    if (this.wsRef.current && document.hasFocus()) {
      sendResize(this.wsRef.current, this.terminal);
    }
    return true;
  }

  // Fit on the next frame(s), retrying while the renderer still reports an
  // implausible size — a single rAF isn't always enough for a recreated
  // renderer or a slow font swap to measure its cell.
  private scheduleFit(retries = 5): void {
    if (this.disposed) return;
    requestAnimationFrame(() => {
      if (this.disposed || !this.isHostVisible()) return;
      if (this.applyFit()) return;
      if (retries > 0) this.scheduleFit(retries - 1);
      // Exhausted all retries while still visible — the renderer never
      // settled. Log so a mis-sized terminal is diagnosable instead of a
      // silent give-up (the not-visible case returned above, so no noise).
      else
        console.warn(
          "[autonomOS] terminal fit still implausible after retries; leaving PTY size unchanged",
        );
    });
  }

  // Load the WebGL renderer and keep it alive across GPU context loss.
  // xterm's WebglAddon silently stops painting if its GL context is lost
  // — common when several panes each hold a context (browsers cap WebGL
  // contexts) or after a GPU reset. Without an onContextLoss handler the
  // terminal appears to freeze: typed input only shows up once a
  // resize/focus nudge forces a full repaint. Disposing and recreating the
  // addon on context loss resumes live rendering.
  private loadWebglAddon(): void {
    if (this.disposed || this.webglAddon) return;
    try {
      const addon = this.createWebglAddon();
      if (!addon) return;
      this.terminal.loadAddon(addon);
      this.webglAddon = addon;
      addon.onContextLoss(() => {
        addon.dispose();
        if (this.webglAddon === addon) this.webglAddon = null;
        // Rebuild on the next visible frame so rendering resumes.
        if (!this.disposed && this.isHostVisible()) {
          this.loadWebglAddon();
          // The recreated renderer hasn't measured its character cell yet;
          // fitting against that stale/unsettled cell mis-computes cols/rows
          // and shrinks the PTY. scheduleFit re-fits on settled frames (with
          // retries + the plausibility guard) and corrects the PTY to the
          // real size, invalidating the change-cache so the ResizeObserver
          // is free to re-fit at the same box. This is the fix for the idle
          // WebGL context-loss self-shrink.
          this.scheduleFit();
        }
      });
    } catch (err) {
      console.warn("WebGL addon failed, falling back to canvas renderer:", err);
      this.webglAddon = null;
    }
  }

  // Touch scroll with inertial scrolling — attached to the HOST (which moves
  // with the terminal between panes), so the listeners install exactly once.
  private installTouchScroll(): void {
    let touchStartY: number | null = null;
    let touchAccum = 0;
    let velocity = 0;
    let lastTouchTime = 0;
    const LINE_HEIGHT_FALLBACK = 14;
    const FRICTION = 0.92;
    const MIN_VELOCITY = 0.3;

    const getLineHeight = (): number =>
      (this.terminal.options.fontSize ?? LINE_HEIGHT_FALLBACK) *
      (this.terminal.options.lineHeight ?? 1);

    const stopInertia = () => {
      if (this.inertiaRaf !== null) {
        cancelAnimationFrame(this.inertiaRaf);
        this.inertiaRaf = null;
      }
    };

    this.host.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length === 1) {
          stopInertia();
          touchStartY = e.touches[0].clientY;
          touchAccum = 0;
          velocity = 0;
          lastTouchTime = Date.now();
        }
      },
      { passive: true },
    );

    this.host.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (this.disposed || touchStartY === null || e.touches.length !== 1)
          return;
        e.preventDefault();

        const now = Date.now();
        const dy = touchStartY - e.touches[0].clientY;
        const dt = Math.max(1, now - lastTouchTime);
        touchStartY = e.touches[0].clientY;
        lastTouchTime = now;

        velocity = 0.6 * (dy / dt) + 0.4 * velocity;

        const lineHeight = getLineHeight();
        if (lineHeight <= 0) return;
        touchAccum += dy;

        const lines = Math.trunc(touchAccum / lineHeight);
        if (lines !== 0) {
          this.terminal.scrollLines(lines);
          touchAccum -= lines * lineHeight;
        }
      },
      { passive: false },
    );

    this.host.addEventListener(
      "touchend",
      () => {
        touchStartY = null;

        if (Math.abs(velocity) < MIN_VELOCITY) {
          velocity = 0;
          touchAccum = 0;
          return;
        }

        let lastFrame = performance.now();
        let inertiaAccum = 0;

        const inertiaStep = (now: number) => {
          if (this.disposed) return;
          const dt = now - lastFrame;
          lastFrame = now;

          velocity *= FRICTION;
          if (Math.abs(velocity) < MIN_VELOCITY) {
            velocity = 0;
            this.inertiaRaf = null;
            return;
          }

          const lineHeight = getLineHeight();
          if (lineHeight <= 0) return;

          inertiaAccum += velocity * dt;
          const lines = Math.trunc(inertiaAccum / lineHeight);
          if (lines !== 0) {
            this.terminal.scrollLines(lines);
            inertiaAccum -= lines * lineHeight;
          }
          this.inertiaRaf = requestAnimationFrame(inertiaStep);
        };

        this.inertiaRaf = requestAnimationFrame(inertiaStep);
      },
      { passive: true },
    );
  }
}

function nudgeResize(
  ws: WebSocket,
  terminal: TerminalInstance,
): ReturnType<typeof setTimeout> | null {
  if (ws.readyState !== WebSocket.OPEN) return null;
  const { cols, rows } = terminal;
  if (isDegenerate(cols, rows)) return null;
  ws.send(JSON.stringify({ type: "resize", cols: cols - 1, rows }));
  return setTimeout(() => sendResize(ws, terminal), 50);
}

function sendResize(ws: WebSocket, terminal: TerminalInstance): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const { cols, rows } = terminal;
  if (isDegenerate(cols, rows)) return;
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
}

/** Safely read a terminal buffer line as text. Returns null on error or missing line. */
function getLineText(
  terminal: TerminalInstance,
  bufferLineNumber: number,
): string | null {
  try {
    const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
    return line?.translateToString(true) ?? null;
  } catch {
    return null;
  }
}

/**
 * Detects plain-text URLs (http:// and https://) in terminal output.
 * Ctrl+Click (Cmd+Click on Mac) opens them in the browser.
 */
class UrlLinkProvider implements ILinkProvider {
  private readonly pattern =
    /https?:\/\/[^\s"'`<>)\]},;]+[^\s"'`<>)\]},;.:!?]/g;
  private readonly terminal: TerminalInstance;

  constructor(terminal: TerminalInstance) {
    this.terminal = terminal;
  }

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const text = getLineText(this.terminal, bufferLineNumber);
    if (!text) {
      callback(undefined);
      return;
    }

    const links: ILink[] = [];

    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((match = this.pattern.exec(text)) !== null) {
      const url = match[0];
      const startX = match.index;

      links.push({
        range: {
          start: { x: startX + 1, y: bufferLineNumber },
          end: { x: startX + url.length + 1, y: bufferLineNumber },
        },
        text: url,
        activate: (event) => {
          if (hasPrimaryModifier(event)) {
            deduplicatedOpen(url);
          }
        },
      });
    }
    this.pattern.lastIndex = 0;

    callback(links.length > 0 ? links : undefined);
  }
}

/**
 * xterm's custom key handler — the terminal-side half of the key-capture
 * boundary (ADR-063). Returns false to DECLINE a key (xterm won't encode it
 * for the PTY; the event still propagates to the browser un-cancelled).
 *
 * ADR-065 freed the legacy ctrl+d/w/b swallow (dead reservations from the
 * pre-dockview split shortcuts): ctrl+d (EOF), ctrl+w-on-Mac (delete-word)
 * and ctrl+b-on-Mac (tmux prefix, readline back-char) now reach the shell
 * again. What still declines: registry-reserved chords (isReservedChord —
 * covers ctrl+b on non-Mac, where ctrl IS `mod` and mod+b is the sidebar)
 * and the mod-key cases below.
 *
 * Exported for the key-policy unit tests; only LiveTerminal wires it.
 */
export function handleKeyEvent(
  event: KeyboardEvent,
  terminal: TerminalInstance,
  wsRef: { current: WebSocket | null },
): boolean {
  if (event.type !== "keydown") return true;

  // App-reserved chords (mod+1..9 pane switching, mod+B, mod+/ — see
  // src/shortcuts/registry.ts) are declined so xterm never encodes them for
  // the PTY. In practice the global dispatcher's capture-phase stopPropagation
  // already keeps them from reaching xterm; this consult is defense in depth
  // that keeps the terminal's decline list synchronized with the registry.
  if (isReservedChord(event)) return false;

  if (!hasPrimaryModifier(event)) return true;

  if (event.key === "c" || event.key === "v") return true;
  if (!isMac && event.shiftKey && (event.key === "C" || event.key === "V"))
    return true;

  const sendToWs = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  };

  // Terminal-clear moved to mod+SHIFT+K (quick-switcher ADR): plain mod+K is
  // the agent quick-switcher (registry). Matched on the PRINTED letter,
  // lowercased — "K" plain-shift and "k" CapsLock+Shift both normalize, and
  // the match stays consistent with how the registry's chord.ts matches
  // letters (physical-code matching is deliberately digits-only there; a
  // code-based match here would steal mod+shift+T on Dvorak, where KeyK
  // prints "t"). preventDefault is best-effort for browser chords sharing
  // this combo (Firefox non-Mac Ctrl+Shift+K is its devtools console and may
  // be browser-reserved; the console can open alongside the clear — accepted).
  if (event.key.toLowerCase() === "k" && event.shiftKey) {
    terminal.clear();
    event.preventDefault();
    return false;
  }

  switch (event.key) {
    case "Backspace":
      sendToWs("\x15");
      return false;
    case "ArrowLeft":
      sendToWs("\x01");
      return false;
    case "ArrowRight":
      sendToWs("\x05");
      return false;
    case "a":
      terminal.selectAll();
      return false;
    // mod+W: on non-Mac, Ctrl+W is Chromium's UNPREVENTABLE close-tab — the
    // tab dies regardless, so declining here only stops xterm from invisibly
    // deleting a word from the shell's line buffer as it goes. On Mac (⌘W,
    // also unpreventable) xterm wouldn't encode a meta chord anyway.
    // Deliberately NOT freed by ADR-065: unlike ctrl+d/b, the browser owns
    // this chord, so "standard terminal behavior" is unreachable for it.
    // "W" too: mod+shift+W is close-WINDOW, same unpreventable class.
    case "w":
    case "W":
      return false;
    case "o":
      sendToWs("\x0f");
      return false;
    default:
      return true;
  }
}
