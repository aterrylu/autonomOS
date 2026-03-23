import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";
import { isMac } from "../utils/platform";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
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
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      macOptionIsMeta: true,
      fontSize: 14,
      fontFamily:
        '"Berkeley Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      theme: THEMES[themeRef.current].terminal,
      scrollback: 10000,
      allowProposedApi: true,
      scrollSensitivity: 3,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const unicodeAddon = new Unicode11Addon();
    terminal.loadAddon(unicodeAddon);
    terminal.unicode.activeVersion = "11";

    terminal.open(container);

    // WebGL is loaded/disposed dynamically — only the visible terminal holds a GPU context
    let webglAddon: WebglAddon | null = null;

    fitAddon.fit();

    terminal.attachCustomKeyEventHandler((event) =>
      handleKeyEvent(event, terminal, wsRef),
    );

    terminal.registerLinkProvider(
      new MarkdownLinkProvider(terminal, sessionId),
    );

    let userScrolledUp = false;
    let programmaticScroll = false;
    let disposed = false;

    terminal.onScroll(() => {
      if (disposed || programmaticScroll) return;
      const buf = terminal.buffer.active;
      const atBottom = buf.baseY - buf.viewportY <= 1;
      userScrolledUp = !atBottom;
    });
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
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
        nudgeTimer = nudgeResize(ws, terminal);
      };

      ws.onmessage = (event) => {
        terminal.write(event.data);
        // Only auto-scroll if the user hasn't manually scrolled up
        if (!userScrolledUp) {
          if (scrollTimer) clearTimeout(scrollTimer);
          scrollTimer = setTimeout(() => {
            programmaticScroll = true;
            terminal.scrollToBottom();
            programmaticScroll = false;
          }, 100);
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        // 4010 = PTY exited (session ended)
        // 4004 = session not found (stale persisted sessionId after server restart)
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
      ws.onerror = () => {
        // Errors are followed by onclose — log but don't act
      };

      wsRef.current = ws;
    }

    connect();

    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    const handleVisibility = () => {
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

    const resizeObserver = new ResizeObserver(() => {
      const { offsetWidth, offsetHeight } = container;
      const isVisible = offsetWidth > 0 && offsetHeight > 0;

      // Dispose WebGL when hidden to free GPU context for the active terminal
      if (!isVisible) {
        if (webglAddon) {
          webglAddon.dispose();
          webglAddon = null;
        }
        return;
      }

      // Load WebGL when becoming visible
      if (!webglAddon) {
        try {
          webglAddon = new WebglAddon();
          terminal.loadAddon(webglAddon);
        } catch (err) {
          console.warn(
            "WebGL addon failed, falling back to canvas renderer:",
            err,
          );
          webglAddon = null;
        }
      }

      fitAddon.fit();
      if (wsRef.current) sendResize(wsRef.current, terminal);
    });
    resizeObserver.observe(container);

    // Touch scroll — xterm.js v6 doesn't handle touch natively (.xterm-screen
    // overlays .xterm-viewport). We translate touch gestures into scrollLines()
    // with inertial scrolling (momentum/flick) on release.
    let touchStartY: number | null = null;
    let touchAccum = 0;
    let velocity = 0;
    let lastTouchTime = 0;
    let inertiaRaf: number | null = null;
    const LINE_HEIGHT_FALLBACK = 14;
    const FRICTION = 0.92;
    const MIN_VELOCITY = 0.3; // px/ms threshold to stop inertia

    function getLineHeight(): number {
      return (
        (terminal.options.fontSize ?? LINE_HEIGHT_FALLBACK) *
        (terminal.options.lineHeight ?? 1)
      );
    }

    function stopInertia() {
      if (inertiaRaf !== null) {
        cancelAnimationFrame(inertiaRaf);
        inertiaRaf = null;
      }
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 1) {
        stopInertia();
        touchStartY = e.touches[0].clientY;
        touchAccum = 0;
        velocity = 0;
        lastTouchTime = Date.now();
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (disposed || touchStartY === null || e.touches.length !== 1) return;
      e.preventDefault();

      const now = Date.now();
      const dy = touchStartY - e.touches[0].clientY;
      const dt = Math.max(1, now - lastTouchTime);
      touchStartY = e.touches[0].clientY;
      lastTouchTime = now;

      // Exponential moving average for smoother velocity tracking
      velocity = 0.6 * (dy / dt) + 0.4 * velocity;

      const lineHeight = getLineHeight();
      if (lineHeight <= 0) return;
      touchAccum += dy;

      const lines = Math.trunc(touchAccum / lineHeight);
      if (lines !== 0) {
        terminal.scrollLines(lines);
        touchAccum -= lines * lineHeight;
      }
    }

    function onTouchEnd() {
      touchStartY = null;

      // Start inertial scroll if flick velocity is high enough
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
          terminal.scrollLines(lines);
          inertiaAccum -= lines * lineHeight;
        }
        inertiaRaf = requestAnimationFrame(inertiaStep);
      }

      inertiaRaf = requestAnimationFrame(inertiaStep);
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });

    termRef.current = terminal;

    return () => {
      disposed = true;
      stopInertia();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (scrollTimer) clearTimeout(scrollTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      resizeObserver.disconnect();
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      wsRef.current?.close();
      terminal.dispose();
      container.replaceChildren();
    };
  }, [sessionId, setStatus, containerRef]);

  // Update theme on live terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = THEMES[theme].terminal;
    }
  }, [theme]);
}

function nudgeResize(
  ws: WebSocket,
  terminal: Terminal,
): ReturnType<typeof setTimeout> | null {
  if (ws.readyState !== WebSocket.OPEN) return null;
  const { cols, rows } = terminal;
  ws.send(JSON.stringify({ type: "resize", cols: cols - 1, rows }));
  return setTimeout(() => sendResize(ws, terminal), 50);
}

function sendResize(ws: WebSocket, terminal: Terminal): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    );
  }
}

/**
 * Detects file paths ending in .md in terminal output.
 * Ctrl+click opens them in the dashboard's /preview route.
 */
class MarkdownLinkProvider implements ILinkProvider {
  private readonly pattern = /(?:^|[\s"'`(])(\/?(?:[\w.~-]+\/)*[\w.-]+\.md)\b/g;
  private readonly terminal: Terminal;
  private readonly sessionId: string;

  constructor(terminal: Terminal, sessionId: string) {
    this.terminal = terminal;
    this.sessionId = sessionId;
  }

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    let line: IBufferLine | undefined;
    try {
      line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    } catch {
      callback(undefined);
      return;
    }

    if (!line) {
      callback(undefined);
      return;
    }

    const text = line.translateToString(true);
    const links: ILink[] = [];

    let match: RegExpExecArray | null = null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((match = this.pattern.exec(text)) !== null) {
      const filePath = match[1];
      const startX = match.index + match[0].indexOf(filePath);

      links.push({
        range: {
          start: { x: startX + 1, y: bufferLineNumber },
          end: { x: startX + filePath.length + 1, y: bufferLineNumber },
        },
        text: filePath,
        activate: (event, linkText) => {
          // Only open on Ctrl+click (Cmd+click on Mac) to avoid accidental opens
          if (!event.ctrlKey && !event.metaKey) return;
          let resolved = linkText;
          if (!linkText.startsWith("/")) {
            const session = useStore
              .getState()
              .sessions.find((s) => s.id === this.sessionId);
            if (session?.workingDirectory) {
              resolved = `${session.workingDirectory}/${linkText}`;
            }
          }
          useStore.getState().openPreview(resolved);
        },
      });
    }
    this.pattern.lastIndex = 0;

    callback(links.length > 0 ? links : undefined);
  }
}

function handleKeyEvent(
  event: KeyboardEvent,
  terminal: Terminal,
  wsRef: React.RefObject<WebSocket | null>,
): boolean {
  if (event.type !== "keydown") return true;

  // On macOS, primaryMod = metaKey, so Ctrl+D/W/B would slip through the
  // primaryMod check below. xterm would then send EOF (Ctrl+D) to the PTY and
  // call stopPropagation(), preventing our App-level capture handler. Suppress
  // these before primaryMod so the App-level shortcuts always take precedence.
  if (event.ctrlKey) {
    const k = event.key.toLowerCase();
    if (k === "d" || k === "w" || k === "b") return false;
  }

  const primaryMod = isMac ? event.metaKey : event.ctrlKey;
  if (!primaryMod) return true;

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
      // Pass Ctrl+O through to Claude Code (show details)
      sendToWs("\x0f");
      return false;
    default:
      return true;
  }
}
