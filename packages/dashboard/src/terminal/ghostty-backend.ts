import { FitAddon, init, Terminal } from "ghostty-web";
import type { TerminalBackend, TerminalOptions } from "./types";

let initPromise: Promise<void> | null = null;
let initError: Error | null = null;

export async function createGhosttyBackend(
  options: TerminalOptions,
): Promise<TerminalBackend> {
  if (initError) {
    throw new Error(`ghostty-web previously failed: ${initError.message}`);
  }
  if (!initPromise) {
    initPromise = init().catch((err) => {
      initError = err instanceof Error ? err : new Error(String(err));
      initPromise = null;
      throw initError;
    });
  }
  await initPromise;

  const terminal = new Terminal(options);

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  return {
    terminal: terminal as unknown as TerminalBackend["terminal"],
    fitAddon,
    createWebglAddon: () => null,
  };
}
