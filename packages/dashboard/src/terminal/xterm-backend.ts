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

  return {
    terminal: terminal as unknown as TerminalBackend["terminal"],
    fitAddon,
    createWebglAddon: () => new WebglAddon(),
  };
}
