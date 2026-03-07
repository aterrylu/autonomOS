import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

// Empty string = same origin. Vite proxy routes /api/* and /ws/* to the server.
const API_URL = "";
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

const TERMINAL_THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39d353",
  white: "#b1bac4",
} as const;

const statusEl = document.getElementById("status")!;
const btnNew = document.getElementById("btn-new") as HTMLButtonElement;
const container = document.getElementById("terminal-container")!;

let terminal: Terminal | null = null;
let ws: WebSocket | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function sendResize(): void {
  if (ws?.readyState === WebSocket.OPEN && terminal) {
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    );
  }
}

async function createSession(): Promise<void> {
  btnNew.disabled = true;
  setStatus("spawning...");

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: "~" }),
    });
  } catch {
    setStatus("server unreachable");
    btnNew.disabled = false;
    return;
  }

  if (!res.ok) {
    setStatus("failed to create session");
    btnNew.disabled = false;
    return;
  }

  const session = await res.json();
  connectTerminal(session.id);
}

function connectTerminal(sessionId: string): void {
  if (terminal) {
    terminal.dispose();
    container.replaceChildren();
  }
  if (ws) ws.close();

  terminal = new Terminal({
    cursorBlink: true,
    macOptionIsMeta: true,
    fontSize: 14,
    fontFamily:
      '"Berkeley Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
    theme: TERMINAL_THEME,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
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

  const nav = navigator as Navigator & { userAgentData?: { platform: string } };
  const isMac = /mac/i.test(
    nav.userAgentData?.platform ?? navigator.platform ?? "",
  );
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    return handleKeyEvent(event, isMac);
  });

  ws = new WebSocket(`${WS_URL}/ws/terminal/${sessionId}`);

  ws.onopen = () => {
    setStatus(`connected: ${sessionId.slice(0, 8)}`);
    btnNew.disabled = false;
    sendResize();
  };

  ws.onmessage = (event) => {
    terminal!.write(event.data);
  };

  ws.onclose = () => {
    setStatus("disconnected");
    btnNew.disabled = false;
  };

  ws.onerror = () => {
    setStatus("connection error");
    btnNew.disabled = false;
  };

  terminal.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && terminal) {
      fitAddon.fit();
      sendResize();
    }
  });
  resizeObserver.observe(container);
}

/**
 * Handle Cmd/Ctrl keyboard shortcuts that xterm.js doesn't natively support.
 * macOptionIsMeta handles Option+key -> ESC+key automatically on macOS.
 * Returns false to prevent xterm.js from processing the event.
 */
function handleKeyEvent(event: KeyboardEvent, isMac: boolean): boolean {
  if (event.type !== "keydown") return true;

  const primaryMod = isMac ? event.metaKey : event.ctrlKey;
  if (!primaryMod) return true;

  // Let browser handle copy/paste natively
  if (event.key === "c" || event.key === "v") return true;
  if (!isMac && event.shiftKey && (event.key === "C" || event.key === "V"))
    return true;

  switch (event.key) {
    case "k":
      terminal?.clear();
      return false;

    case "Backspace":
      sendToWs("\x15"); // Ctrl+U: delete to beginning of line
      return false;

    case "ArrowLeft":
      sendToWs("\x01"); // Ctrl+A: beginning of line
      return false;

    case "ArrowRight":
      sendToWs("\x05"); // Ctrl+E: end of line
      return false;

    case "a":
      terminal?.selectAll();
      return false;

    default:
      return true;
  }
}

function sendToWs(data: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

btnNew.addEventListener("click", createSession);
