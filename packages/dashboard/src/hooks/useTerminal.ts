import { useCallback, useEffect, useRef, useState } from "react";
import type { CopyToastState } from "../components/CopyToast";
import { isReservedChord } from "../shortcuts/registry";
import { THEMES, useStore } from "../store";
import { isDegenerate, isPlausibleFit } from "../terminal/resize";
import type {
  IFitAddon,
  ILink,
  ILinkProvider,
  IWebglAddon,
  TerminalBackend,
  TerminalInstance,
} from "../terminal/types";
import { createXtermBackend } from "../terminal/xterm-backend";
import {
  COPY_TOAST_DISPLAY_MS,
  shouldSuppressCopyToast,
} from "../utils/copyToast";
import { deduplicatedOpen } from "../utils/deduplicatedOpen";
import { hasPrimaryModifier, isMac } from "../utils/platform";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

// ── Terminal focus registry ─────────────────────────────────────────
// Allows external code (sidebar click handlers) to focus a specific
// session's terminal without going through React's effect chain.
const terminalRegistry = new Map<string, TerminalInstance>();

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
  let attempts = 0;
  function tryFocus() {
    pendingFocusRaf = null;
    const term = terminalRegistry.get(sessionId);
    if (!term) return;
    const textarea = term.textarea;
    if (textarea && textarea.offsetParent !== null) {
      term.focus();
      return;
    }
    if (++attempts < 10) {
      pendingFocusRaf = requestAnimationFrame(tryFocus);
    }
  }
  pendingFocusRaf = requestAnimationFrame(tryFocus);
}

const MAX_RETRY_DELAY = 10000;

/**
 * Manages a single terminal instance for a given sessionId.
 * Unlike the old hook, this does NOT read sessionId from the store —
 * it receives it as a parameter so multiple instances can coexist.
 */
export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string,
) {
  const termRef = useRef<TerminalInstance | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Transient "Copied N chars" confirmation for OSC 52 auto-copy. State drives
  // the CopyToast overlay; refs hold the coalescing/auto-dismiss bookkeeping so
  // the handler stays stable (it never re-creates the terminal effect).
  const [copyToast, setCopyToast] = useState<CopyToastState | null>(null);
  const copyToastIdRef = useRef(0);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCopyTextRef = useRef<string | null>(null);
  const lastCopyAtRef = useRef(0);

  const handleClipboardCopy = useCallback(
    ({ text, ok }: { text: string; ok: boolean }) => {
      const now = Date.now();
      // Coalesce streaming re-syncs of an unchanged selection into one toast.
      if (
        shouldSuppressCopyToast(
          { text: lastCopyTextRef.current, at: lastCopyAtRef.current },
          { text, ok, at: now },
        )
      ) {
        lastCopyAtRef.current = now;
        return;
      }
      lastCopyTextRef.current = text;
      lastCopyAtRef.current = now;
      copyToastIdRef.current += 1;
      setCopyToast({ id: copyToastIdRef.current, chars: [...text].length, ok });
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = setTimeout(
        () => setCopyToast(null),
        COPY_TOAST_DISPLAY_MS,
      );
    },
    [],
  );

  // Clear the pending dismiss timer on unmount.
  useEffect(
    () => () => {
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    },
    [],
  );

  const theme = useStore((s) => s.theme);
  const setStatus = useStore((s) => s.setStatus);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Track whether this session is the active one, so we can update status
  const activePane = useStore((s) => s.activePane);
  const isActive =
    activePane?.type === "session" && activePane.id === sessionId;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Focus terminal when it becomes the active session
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [isActive]);

  // Auto-clear unread notifications whenever this session is active and has unreads
  const markRead = useStore((s) => s.markNotificationsRead);
  const unreadCount = useStore((s) => s.notificationCounts[sessionId] ?? 0);
  useEffect(() => {
    if (isActive && unreadCount > 0) {
      markRead(sessionId);
    }
  }, [isActive, unreadCount, sessionId, markRead]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    // Mutable references for cleanup — populated by the async init below.
    // The synchronous cleanup function and the async body both access these.
    let terminal: TerminalInstance | null = null;
    let fitAddon: IFitAddon | null = null;
    let webglAddon: IWebglAddon | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let inertiaRaf: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let handleVisibility: (() => void) | null = null;
    let handleFocus: (() => void) | null = null;
    let onTouchStart: ((e: TouchEvent) => void) | null = null;
    let onTouchMove: ((e: TouchEvent) => void) | null = null;
    let onTouchEnd: (() => void) | null = null;

    // Async IIFE — the WebSocket connect/retry logic below runs async.
    (async () => {
      let backend: TerminalBackend;
      try {
        backend = createXtermBackend(
          {
            cursorBlink: true,
            fontSize: 14,
            fontFamily:
              '"Berkeley Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
            theme: THEMES[themeRef.current].terminal,
            scrollback: 10000,
          },
          handleClipboardCopy,
        );
      } catch (err) {
        console.error("Failed to create terminal backend:", err);
        if (isActiveRef.current) {
          setStatus("terminal failed to load");
        }
        container.textContent =
          "Terminal failed to initialize. Reload the dashboard to retry.";
        container.style.cssText =
          "color:#ea6c73;padding:16px;font-size:13px;font-family:monospace";
        return;
      }

      // Defensive: if the effect was already torn down, dispose immediately.
      if (disposed) {
        backend.terminal.dispose();
        return;
      }

      terminal = backend.terminal;
      fitAddon = backend.fitAddon;
      const createWebglAddon = backend.createWebglAddon;

      try {
        terminal.open(container);
        fitAddon.fit();
      } catch (err) {
        console.error(`Terminal open/fit failed for ${sessionId}:`, err);
        if (isActiveRef.current) {
          setStatus("terminal render failed");
        }
        terminal.dispose();
        return;
      }

      terminal.attachCustomKeyEventHandler((event) =>
        handleKeyEvent(event, terminal!, wsRef),
      );

      terminal.registerLinkProvider(new UrlLinkProvider(terminal));
      // xterm.js handles OSC 8 hyperlinks via the linkHandler constructor
      // option in xterm-backend.ts (Ctrl/Cmd+Click gated).

      let userScrolledUp = false;
      let programmaticScroll = false;

      terminal.onScroll(() => {
        if (disposed || programmaticScroll) return;
        const buf = terminal!.buffer.active;
        const atBottom = buf.baseY - buf.viewportY <= 1;
        userScrolledUp = !atBottom;
      });

      let retryDelay = 1000;

      function connect() {
        if (disposed) return;
        userScrolledUp = false;

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (scrollTimer) {
          clearTimeout(scrollTimer);
          scrollTimer = null;
        }
        if (nudgeTimer) {
          clearTimeout(nudgeTimer);
          nudgeTimer = null;
        }
        wsRef.current?.close();

        const ws = new WebSocket(`${WS_URL}/ws/terminal/${sessionId}`);

        ws.onopen = () => {
          retryDelay = 1000;
          if (isActiveRef.current) {
            setStatus(`connected: ${sessionId.slice(0, 8)}`);
          }
          if (document.hasFocus()) {
            nudgeTimer = nudgeResize(ws, terminal!);
          }
        };

        ws.onmessage = (event) => {
          if (disposed) return;
          try {
            terminal!.write(event.data);
          } catch (err) {
            // xterm.js v6.0.0 has a bug in its DECRQM ($p) handler that throws
            // on certain escape sequences emitted by Ink (used by Claude Code).
            // An uncaught throw mid-write freezes the terminal — isolate it here
            // so the next chunk still renders.
            console.warn("terminal.write() threw, continuing:", err);
          }
          if (!userScrolledUp) {
            if (scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
              programmaticScroll = true;
              terminal!.scrollToBottom();
              programmaticScroll = false;
            }, 100);
          }
        };

        ws.onclose = (event) => {
          if (disposed) return;
          if (event.code === 4010 || event.code === 4004) {
            const store = useStore.getState();
            const { activePane } = store;
            if (activePane?.type === "session" && activePane.id === sessionId) {
              store.switchPane(null);
            }
            store.fetchSessions();
            return;
          }
          if (isActiveRef.current) {
            setStatus("reconnecting...");
          }
          reconnectTimer = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
            connect();
          }, retryDelay);
        };
        ws.onerror = (event) => {
          console.warn(`WebSocket error for session ${sessionId}:`, event);
        };

        wsRef.current = ws;
      }

      connect();

      terminal.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      handleVisibility = () => {
        if (
          document.visibilityState === "visible" &&
          wsRef.current?.readyState !== WebSocket.OPEN &&
          wsRef.current?.readyState !== WebSocket.CONNECTING
        ) {
          retryDelay = 1000;
          connect();
        }
      };
      document.addEventListener("visibilitychange", handleVisibility);

      const isContainerVisible = (): boolean =>
        container.offsetWidth > 0 && container.offsetHeight > 0;

      // Last container box we actually fit to — lets us skip redundant fits
      // (a ResizeObserver can fire without a real dimension change), which is
      // what bakes sub-pixel cell-measurement drift into a stepwise shrink.
      // Reset to 0 to force the next fit (e.g. after an implausible mis-measure).
      let lastFitW = 0;
      let lastFitH = 0;

      // Fit the terminal to its container and push the size to the PTY — but
      // ONLY if the fit produced a PLAUSIBLE geometry. A freshly (re)created
      // WebGL renderer may not have measured its character cell yet, so fit()
      // can compute a wildly-too-small cols/rows (isPlausibleFit's headline
      // case). isDegenerate alone only blocks the 2×1 floor, so such a
      // mis-measure would otherwise reach the PTY and wedge the remote tty until
      // a manual refresh (the idle self-shrink). On an implausible fit we skip
      // the send, invalidate the cache (so a later box change still retries), and
      // let scheduleFit retry on a settled frame. Returns true once applied.
      const applyFit = (): boolean => {
        if (disposed || !terminal || !fitAddon || !isContainerVisible())
          return false;
        try {
          fitAddon.fit();
        } catch (err) {
          console.warn("fitAddon.fit() failed:", err);
          return false;
        }
        const w = container.offsetWidth;
        const h = container.offsetHeight;
        if (!isPlausibleFit(terminal.cols, terminal.rows, w, h)) {
          lastFitW = 0;
          lastFitH = 0;
          return false;
        }
        lastFitW = w;
        lastFitH = h;
        if (wsRef.current && document.hasFocus()) {
          sendResize(wsRef.current, terminal);
        }
        return true;
      };

      // Fit on the next frame(s), retrying while the renderer still reports an
      // implausible size — a single rAF isn't always enough for a recreated
      // renderer or a slow font swap to measure its cell.
      const scheduleFit = (retries = 5): void => {
        if (disposed) return;
        requestAnimationFrame(() => {
          if (disposed || !isContainerVisible()) return;
          if (applyFit()) return;
          if (retries > 0) scheduleFit(retries - 1);
          // Exhausted all retries while still visible — the renderer never
          // settled. Log so a mis-sized terminal is diagnosable instead of a
          // silent give-up (the not-visible case returned above, so no noise).
          else
            console.warn(
              "[autonomOS] terminal fit still implausible after retries; leaving PTY size unchanged",
            );
        });
      };

      // Load the WebGL renderer and keep it alive across GPU context loss.
      // xterm's WebglAddon silently stops painting if its GL context is lost
      // — common when several panes each hold a context (browsers cap WebGL
      // contexts, and this hook creates/disposes one per pane on visibility)
      // or after a GPU reset. Without an onContextLoss handler the terminal
      // appears to freeze: typed input only shows up once a resize/focus
      // nudge forces a full repaint. Disposing and recreating the addon on
      // context loss resumes live rendering.
      const loadWebglAddon = (): void => {
        if (disposed || webglAddon || !terminal) return;
        try {
          const addon = createWebglAddon();
          if (!addon) return;
          terminal.loadAddon(addon);
          webglAddon = addon;
          addon.onContextLoss(() => {
            addon.dispose();
            if (webglAddon === addon) webglAddon = null;
            // Rebuild on the next visible frame so rendering resumes.
            if (!disposed && isContainerVisible()) {
              loadWebglAddon();
              // The recreated renderer hasn't measured its character cell yet;
              // fitting against that stale/unsettled cell mis-computes cols/rows
              // and shrinks the PTY. scheduleFit re-fits on settled frames (with
              // retries + the plausibility guard) and corrects the PTY to the
              // real size, invalidating the change-cache so the ResizeObserver
              // is free to re-fit at the same box. This is the fix for the idle
              // WebGL context-loss self-shrink.
              scheduleFit();
            }
          });
        } catch (err) {
          console.warn(
            "WebGL addon failed, falling back to canvas renderer:",
            err,
          );
          webglAddon = null;
        }
      };

      handleFocus = () => {
        if (disposed) return;
        if (
          isContainerVisible() &&
          wsRef.current?.readyState === WebSocket.OPEN
        ) {
          // Re-fit (plausibility-guarded) to correct any stale size taken while
          // unfocused, then nudge for a repaint. Only nudge on a PLAUSIBLE fit —
          // nudgeResize is guarded solely by isDegenerate, so nudging after a
          // failed fit could ship a mis-measured size to the PTY for a frame.
          // If the renderer isn't settled, scheduleFit retries instead.
          if (applyFit()) {
            if (nudgeTimer) clearTimeout(nudgeTimer);
            nudgeTimer = nudgeResize(wsRef.current, terminal!);
          } else {
            scheduleFit();
          }
        }
      };
      window.addEventListener("focus", handleFocus);

      resizeObserver = new ResizeObserver(() => {
        const isVisible = isContainerVisible();

        // Dispose WebGL when hidden to free GPU context for the active terminal
        if (!isVisible) {
          if (webglAddon) {
            webglAddon.dispose();
            webglAddon = null;
          }
          return;
        }

        // Load WebGL when becoming visible (GPU rendering for xterm.js)
        const hadAddon = !!webglAddon;
        loadWebglAddon();

        const w = container.offsetWidth;
        const h = container.offsetHeight;
        if (!hadAddon && webglAddon) {
          // Just (re)created the renderer this tick — it hasn't measured its
          // cell yet, so fit on a settled frame (scheduleFit retries until the
          // fit is plausible) rather than synchronously against a stale cell.
          scheduleFit();
        } else if (w !== lastFitW || h !== lastFitH) {
          // Box actually changed — fit now; if the renderer looks unsettled,
          // applyFit invalidates the cache and scheduleFit retries next frame.
          if (!applyFit()) scheduleFit();
        }
      });
      resizeObserver.observe(container);

      // Touch scroll with inertial scrolling
      let touchStartY: number | null = null;
      let touchAccum = 0;
      let velocity = 0;
      let lastTouchTime = 0;
      const LINE_HEIGHT_FALLBACK = 14;
      const FRICTION = 0.92;
      const MIN_VELOCITY = 0.3;

      function getLineHeight(): number {
        return (
          (terminal!.options.fontSize ?? LINE_HEIGHT_FALLBACK) *
          (terminal!.options.lineHeight ?? 1)
        );
      }

      function stopInertia() {
        if (inertiaRaf !== null) {
          cancelAnimationFrame(inertiaRaf);
          inertiaRaf = null;
        }
      }

      onTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 1) {
          stopInertia();
          touchStartY = e.touches[0].clientY;
          touchAccum = 0;
          velocity = 0;
          lastTouchTime = Date.now();
        }
      };

      onTouchMove = (e: TouchEvent) => {
        if (disposed || touchStartY === null || e.touches.length !== 1) return;
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
          terminal!.scrollLines(lines);
          touchAccum -= lines * lineHeight;
        }
      };

      onTouchEnd = () => {
        touchStartY = null;

        if (Math.abs(velocity) < MIN_VELOCITY) {
          velocity = 0;
          touchAccum = 0;
          return;
        }

        let lastFrame = performance.now();
        let inertiaAccum = 0;

        function inertiaStep(now: number) {
          if (disposed) return;
          const dt = now - lastFrame;
          lastFrame = now;

          velocity *= FRICTION;
          if (Math.abs(velocity) < MIN_VELOCITY) {
            velocity = 0;
            inertiaRaf = null;
            return;
          }

          const lineHeight = getLineHeight();
          if (lineHeight <= 0) return;

          inertiaAccum += velocity * dt;
          const lines = Math.trunc(inertiaAccum / lineHeight);
          if (lines !== 0) {
            terminal!.scrollLines(lines);
            inertiaAccum -= lines * lineHeight;
          }
          inertiaRaf = requestAnimationFrame(inertiaStep);
        }

        inertiaRaf = requestAnimationFrame(inertiaStep);
      };

      container.addEventListener("touchstart", onTouchStart, {
        passive: true,
      });
      container.addEventListener("touchmove", onTouchMove, { passive: false });
      container.addEventListener("touchend", onTouchEnd, { passive: true });

      termRef.current = terminal;
      terminalRegistry.set(sessionId, terminal);
    })();

    return () => {
      disposed = true;
      if (terminal && terminalRegistry.get(sessionId) === terminal) {
        terminalRegistry.delete(sessionId);
      }
      if (inertiaRaf !== null) cancelAnimationFrame(inertiaRaf);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (scrollTimer) clearTimeout(scrollTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      if (handleVisibility)
        document.removeEventListener("visibilitychange", handleVisibility);
      if (handleFocus) window.removeEventListener("focus", handleFocus);
      resizeObserver?.disconnect();
      if (onTouchStart)
        container.removeEventListener("touchstart", onTouchStart);
      if (onTouchMove) container.removeEventListener("touchmove", onTouchMove);
      if (onTouchEnd) container.removeEventListener("touchend", onTouchEnd);
      if (webglAddon) webglAddon.dispose();
      wsRef.current?.close();
      terminal?.dispose();
      container.replaceChildren();
      termRef.current = null;
    };
  }, [sessionId, setStatus, containerRef, handleClipboardCopy]);

  // Update theme on live terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = THEMES[theme].terminal;
    }
  }, [theme]);

  return { copyToast };
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

function handleKeyEvent(
  event: KeyboardEvent,
  terminal: TerminalInstance,
  wsRef: React.RefObject<WebSocket | null>,
): boolean {
  if (event.type !== "keydown") return true;

  // App-reserved chords (mod+1..9 pane switching, mod+B, mod+/ — see
  // src/shortcuts/registry.ts) are declined so xterm never encodes them for
  // the PTY. In practice the global dispatcher's capture-phase stopPropagation
  // already keeps them from reaching xterm; this consult is defense in depth
  // that keeps the terminal's decline list synchronized with the registry.
  if (isReservedChord(event)) return false;

  if (event.ctrlKey) {
    const k = event.key.toLowerCase();
    if (k === "d" || k === "w" || k === "b") return false;
  }

  if (!hasPrimaryModifier(event)) return true;

  if (event.key === "c" || event.key === "v") return true;
  if (!isMac && event.shiftKey && (event.key === "C" || event.key === "V"))
    return true;

  const sendToWs = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  };

  switch (event.key) {
    case "k":
      terminal.clear();
      return false;
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
    case "b":
      return false;
    case "d":
      return false;
    case "w":
      return false;
    case "o":
      sendToWs("\x0f");
      return false;
    default:
      return true;
  }
}
