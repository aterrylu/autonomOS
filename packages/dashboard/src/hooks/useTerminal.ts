import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

const isMac = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform: string } })
    .userAgentData?.platform ??
    navigator.platform ??
    "",
);

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

    const ws = new WebSocket(`${WS_URL}/ws/terminal/${sessionId}`);

    ws.onopen = () => {
      setStatus(`connected: ${sessionId.slice(0, 8)}`);
      sendResize(ws, terminal);
    };

    ws.onmessage = (event) => terminal.write(event.data);

    ws.onclose = (event) => {
      // 4010 = PTY exited (session ended)
      if (event.code === 4010) {
        useStore.getState().setSessionId(null);
        useStore.getState().fetchSessions();
      }
      setStatus("disconnected");
    };
    ws.onerror = () => setStatus("connection error");

    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize(ws, terminal);
    });
    resizeObserver.observe(container);

    termRef.current = terminal;
    wsRef.current = ws;

    return () => {
      resizeObserver.disconnect();
      ws.close();
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
    default:
      return true;
  }
}
