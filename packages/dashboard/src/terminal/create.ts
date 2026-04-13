import { createGhosttyBackend } from "./ghostty-backend";
import type {
  TerminalBackend,
  TerminalOptions,
  TerminalRenderer,
} from "./types";
import { createXtermBackend } from "./xterm-backend";

export async function createTerminalBackend(
  renderer: TerminalRenderer,
  options: TerminalOptions,
): Promise<TerminalBackend> {
  switch (renderer) {
    case "ghostty-web":
      return createGhosttyBackend(options);
    case "xterm":
      return createXtermBackend(options);
  }
}

export type { TerminalBackend, TerminalOptions, TerminalRenderer };
