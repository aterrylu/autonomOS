import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { deduplicatedOpen } from "../utils/deduplicatedOpen";
import { hasPrimaryModifier } from "../utils/platform";
import type { TerminalBackend, TerminalOptions } from "./types";

export function createXtermBackend(options: TerminalOptions): TerminalBackend {
  const terminal = new Terminal({
    ...options,
    macOptionIsMeta: true,
    allowProposedApi: true,
    scrollSensitivity: 3,
    linkHandler: {
      activate(event: MouseEvent, uri: string) {
        if (hasPrimaryModifier(event)) {
          deduplicatedOpen(uri);
        }
      },
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const unicodeAddon = new Unicode11Addon();
  terminal.loadAddon(unicodeAddon);
  terminal.unicode.activeVersion = "11";

  // xterm.js 6.0.0 has a bug where its built-in DECRQM (mode report) handler
  // throws `ReferenceError: t is not defined` on `CSI $ p` / `CSI ? $ p` —
  // Ink (used by Claude Code) emits `CSI ? 2026 $ p` to probe synchronized-output
  // support, which freezes the terminal mid-write. Shadow both handlers with a
  // safe no-op before the built-in runs.
  terminal.parser.registerCsiHandler(
    { intermediates: "$", final: "p" },
    () => true,
  );
  terminal.parser.registerCsiHandler(
    { prefix: "?", intermediates: "$", final: "p" },
    () => true,
  );

  // OSC 52 writes to the system clipboard. Read requests (`?`) are dropped so
  // a remote process can't exfiltrate the user's clipboard.
  terminal.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(";");
    if (semi === -1) return true;
    const payload = data.slice(semi + 1);
    if (payload === "?") return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn("OSC 52 clipboard write failed:", err);
      });
    } catch (err) {
      console.warn("OSC 52 decode failed:", err);
    }
    return true;
  });

  return {
    terminal: terminal as unknown as TerminalBackend["terminal"],
    fitAddon,
    createWebglAddon: () => new WebglAddon(),
  };
}
