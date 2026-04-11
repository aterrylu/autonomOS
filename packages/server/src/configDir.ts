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

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}
