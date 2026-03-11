import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";
import { isMac } from "../utils/platform";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
const MAX_RETRY_DELAY = 10000;

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const sessionId = useStore((s) => s.sessionId);
  const theme = useStore((s) => s.theme);
  const setStatus = useStore((s) => s.setStatus);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const container = containerRef.current;
    if (!sessionId || !container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      macOptionIsMeta: true,
      fontSize: 14,
      fontFamily:
        '"Berkeley Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      theme: THEMES[themeRef.current].terminal,
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const unicodeAddon = new Unicode11Addon();
    terminal.loadAddon(unicodeAddon);
    terminal.unicode.activeVersion = "11";

    terminal.open(container);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch (err) {
      console.warn("WebGL addon failed, falling back to canvas renderer:", err);
    }

    fitAddon.fit();

    terminal.attachCustomKeyEventHandler((event) =>
      handleKeyEvent(event, terminal, wsRef),
    );

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    function connect() {
      if (disposed) return;

      // Cancel pending timers and close stale socket
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
        setStatus(`connected: ${sessionId!.slice(0, 8)}`);
        // Nudge resize to force TUI apps (Claude Code) to fully redraw.
        // Without this, reconnects can show the cursor below the TUI
        // because the replayed buffer may be missing alternate-screen
        // escape sequences that were truncated from the start.
        nudgeTimer = nudgeResize(ws, terminal);
      };

      ws.onmessage = (event) => {
        // Only auto-scroll if user is already at/near the bottom
        const buf = terminal.buffer.active;
        const atBottom = buf.viewportY >= buf.baseY - 1;
        terminal.write(event.data);
        if (atBottom) {
          if (scrollTimer) clearTimeout(scrollTimer);
          scrollTimer = setTimeout(() => terminal.scrollToBottom(), 100);
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        // 4010 = PTY exited (session ended)
        if (event.code === 4010) {
          useStore.getState().setSessionId(null);
          useStore.getState().fetchSessions();
          return;
        }
        setStatus("reconnecting...");
        reconnectTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
          connect();
        }, retryDelay);
      };
      ws.onerror = () => {};

      wsRef.current = ws;
    }

    connect();

    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // Reconnect when tab regains focus (browser may have killed the WS)
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
      fitAddon.fit();
      if (wsRef.current) sendResize(wsRef.current, terminal);
    });
    resizeObserver.observe(container);

    termRef.current = terminal;

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (scrollTimer) clearTimeout(scrollTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      resizeObserver.disconnect();
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

/**
 * Briefly resize the PTY then restore, forcing full-screen TUI apps
 * to redraw. This fixes cursor-below-rendering after buffer replay.
 * Returns the restore timer handle for cleanup.
 */
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

function handleKeyEvent(
  event: KeyboardEvent,
  terminal: Terminal,
  wsRef: React.RefObject<WebSocket | null>,
): boolean {
  if (event.type !== "keydown") return true;

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
      // Suppress terminal input — App-level handler toggles the sidebar
      return false;
    case "o":
      // Pass Ctrl+O through to Claude Code (show details)
      sendToWs("\x0f");
      return false;
    default:
      return true;
  }
}
