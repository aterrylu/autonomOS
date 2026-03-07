import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

// Empty string = same origin. Vite proxy routes /api/* and /ws/* to the server.
const API_URL = "";
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

type ThemeName = "midnight" | "daylight" | "void";

interface AppTheme {
  terminal: Record<string, string>;
  page: { bg: string; fg: string; border: string; statusFg: string };
}

const THEMES: Record<ThemeName, AppTheme> = {
  midnight: {
    terminal: {
      background: "#0a0e14",
      foreground: "#b3b1ad",
      cursor: "#e6b450",
      selectionBackground: "#1d3b53",
      black: "#01060e",
      red: "#ea6c73",
      green: "#91b362",
      yellow: "#e6b450",
      blue: "#53bdfa",
      magenta: "#fae38e",
      cyan: "#90e1c6",
      white: "#c7c7c7",
    },
    page: {
      bg: "#0a0e14",
      fg: "#b3b1ad",
      border: "#1c2433",
      statusFg: "#626a73",
    },
  },
  daylight: {
    terminal: {
      background: "#fafaf8",
      foreground: "#2e3440",
      cursor: "#d73a49",
      selectionBackground: "#d7e4f0",
      black: "#2e3440",
      red: "#d73a49",
      green: "#22863a",
      yellow: "#b08800",
      blue: "#0366d6",
      magenta: "#6f42c1",
      cyan: "#1b7c83",
      white: "#959da5",
    },
    page: {
      bg: "#fafaf8",
      fg: "#2e3440",
      border: "#e1e4e8",
      statusFg: "#959da5",
    },
  },
  void: {
    terminal: {
      background: "#000000",
      foreground: "#c9d1d9",
      cursor: "#00ff9f",
      selectionBackground: "#1a3a2a",
      black: "#0d1117",
      red: "#ff6b6b",
      green: "#00ff9f",
      yellow: "#ffda6b",
      blue: "#6bc5ff",
      magenta: "#d2a8ff",
      cyan: "#76e4f7",
      white: "#f0f6fc",
    },
    page: {
      bg: "#000000",
      fg: "#c9d1d9",
      border: "#161b22",
      statusFg: "#6e7681",
    },
  },
};

const THEME_ORDER: ThemeName[] = ["midnight", "daylight", "void"];

const stored = localStorage.getItem("theme");
let currentTheme: ThemeName =
  stored && stored in THEMES ? (stored as ThemeName) : "midnight";

const statusEl = document.getElementById("status")!;
const btnNew = document.getElementById("btn-new") as HTMLButtonElement;
const btnTheme = document.getElementById("btn-theme") as HTMLButtonElement;
const container = document.getElementById("terminal-container")!;

let terminal: Terminal | null = null;
let ws: WebSocket | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function applyTheme(name: ThemeName): void {
  currentTheme = name;
  localStorage.setItem("theme", name);
  const theme = THEMES[name];

  document.body.style.background = theme.page.bg;
  document.body.style.color = theme.page.fg;
  document.querySelector("header")!.style.borderBottomColor = theme.page.border;
  statusEl.style.color = theme.page.statusFg;

  btnTheme.textContent = name[0].toUpperCase() + name.slice(1);

  if (terminal) {
    terminal.options.theme = theme.terminal;
  }
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
    theme: THEMES[currentTheme].terminal,
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
btnTheme.addEventListener("click", () => {
  const next =
    THEME_ORDER[(THEME_ORDER.indexOf(currentTheme) + 1) % THEME_ORDER.length];
  applyTheme(next);
});
applyTheme(currentTheme);
