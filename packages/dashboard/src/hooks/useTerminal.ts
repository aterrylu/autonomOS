import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
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
  const activeSessionId = useStore((s) => s.sessionId);
  const isActiveRef = useRef(activeSessionId === sessionId);
  isActiveRef.current = activeSessionId === sessionId;

  // Focus terminal when it becomes the active session
  useEffect(() => {
    if (activeSessionId === sessionId && termRef.current) {
      termRef.current.focus();
    }
  }, [activeSessionId, sessionId]);

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

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    function connect() {
      if (disposed) return;

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
        const buf = terminal.buffer.active;
        const atBottom = buf.baseY - buf.viewportY <= 3;
        terminal.write(event.data);
        if (atBottom) {
          if (scrollTimer) clearTimeout(scrollTimer);
          scrollTimer = setTimeout(() => terminal.scrollToBottom(), 100);
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        // 4010 = PTY exited (session ended)
        // 4004 = session not found (stale persisted sessionId after server restart)
        if (event.code === 4010 || event.code === 4004) {
          const store = useStore.getState();
          if (store.sessionId === sessionId) {
            store.setSessionId(null);
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
      ws.onerror = () => {};

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
