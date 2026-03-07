import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

// Vite proxy handles routing — use relative URLs
const API_URL = "";
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

const statusEl = document.getElementById("status")!;
const btnNew = document.getElementById("btn-new") as HTMLButtonElement;
const container = document.getElementById("terminal-container")!;

let terminal: Terminal | null = null;
let ws: WebSocket | null = null;
let fitAddon: FitAddon | null = null;

function setStatus(text: string) {
  statusEl.textContent = text;
}

function clearContainer() {
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
}

async function createSession() {
  btnNew.disabled = true;
  setStatus("spawning...");

  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workingDirectory: "~",
    }),
  });

  if (!res.ok) {
    setStatus("failed to create session");
    btnNew.disabled = false;
    return;
  }

  const session = await res.json();
  connectTerminal(session.id);
}

function connectTerminal(sessionId: string) {
  // Clean up existing terminal
  if (terminal) {
    terminal.dispose();
    clearContainer();
  }
  if (ws) ws.close();

  // Create terminal
  terminal = new Terminal({
    cursorBlink: true,
    macOptionIsMeta: true,
    fontSize: 14,
    fontFamily: '"Berkeley Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
    theme: {
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
    },
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Unicode 11 support for emoji and wide characters
  const unicodeAddon = new Unicode11Addon();
  terminal.loadAddon(unicodeAddon);
  terminal.unicode.activeVersion = "11";

  terminal.open(container);

  // Try WebGL rendering for GPU acceleration
  try {
    terminal.loadAddon(new WebglAddon());
  } catch {
    console.warn("WebGL addon failed, falling back to canvas renderer");
  }

  fitAddon.fit();

  // Cross-platform keyboard shortcuts
  // macOptionIsMeta handles Option+key → ESC+key automatically on macOS
  // We only need to handle Cmd/Ctrl shortcuts that xterm.js doesn't know about
  const isMac = navigator.platform.toUpperCase().includes("MAC");

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== "keydown") return true;

    const primaryMod = isMac ? event.metaKey : event.ctrlKey;
    if (!primaryMod) return true;

    const send = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };

    // Clear terminal (Cmd+K / Ctrl+K)
    if (event.key === "k") {
      terminal!.clear();
      return false;
    }

    // Delete to beginning of line (Cmd+Backspace / Ctrl+Backspace → Ctrl+U)
    if (event.key === "Backspace") {
      send("\x15");
      return false;
    }

    // Beginning of line (Cmd+Left / Ctrl+Home → Ctrl+A)
    if (event.key === "ArrowLeft") {
      send("\x01");
      return false;
    }

    // End of line (Cmd+Right / Ctrl+End → Ctrl+E)
    if (event.key === "ArrowRight") {
      send("\x05");
      return false;
    }

    // Select all (Cmd+A / Ctrl+A)
    if (event.key === "a") {
      terminal!.selectAll();
      return false;
    }

    // Copy/paste — let browser handle natively
    if (event.key === "c" || event.key === "v") {
      return true;
    }

    // Ctrl+Shift+C/V → copy/paste on Linux (GNOME terminal convention)
    if (!isMac && event.shiftKey && (event.key === "C" || event.key === "V")) {
      return true;
    }

    return true;
  });

  // Connect WebSocket
  ws = new WebSocket(`${WS_URL}/ws/terminal/${sessionId}`);

  ws.onopen = () => {
    setStatus(`connected: ${sessionId.slice(0, 8)}`);
    btnNew.disabled = false;

    // Send initial size
    if (terminal && fitAddon) {
      ws!.send(JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      }));
    }
  };

  // PTY output → terminal
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

  // Terminal input → WebSocket → PTY
  terminal.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon && terminal) {
      fitAddon.fit();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }));
      }
    }
  });
  resizeObserver.observe(container);
}

btnNew.addEventListener("click", createSession);
