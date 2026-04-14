/**
 * Shared config directory — ~/.autonomos/
 *
 * All modules that persist data (settings, sessions) should use these
 * helpers instead of duplicating the HOME / mkdir logic.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");

/**
 * Config directory — defaults to ~/.autonomos/, overridable via AUTONOMOS_CONFIG_DIR.
 * The override is used by `make dev` in worktrees to isolate dev instances.
 */
export const CONFIG_DIR =
  process.env.AUTONOMOS_CONFIG_DIR?.trim() || join(HOME, ".autonomos");

let _testOverride: string | null = null;

/** Returns the active config dir — test override if set, otherwise CONFIG_DIR. */
export function getConfigDir(): string {
  return _testOverride ?? CONFIG_DIR;
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** For testing — redirect all config reads to an isolated temp directory. */
export function _setConfigDirForTesting(dir: string): void {
  _testOverride = dir;
}

/** For testing — restore default config dir. */
export function _resetConfigDirForTesting(): void {
  _testOverride = null;
}
