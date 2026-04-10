/**
 * Shared config directory — ~/.autonomos/ by default.
 *
 * All modules that persist data (settings, sessions, pinned, templates)
 * should use these helpers instead of duplicating the HOME / mkdir logic.
 *
 * Override via the `AUTONOMOS_CONFIG_DIR` environment variable so dev (:3101)
 * and prod (:3100) do not share the same sessions.json, pinned-sessions.json,
 * settings.json, or templates/. Without this, a dev server starting up will
 * try to resume every running prod session — cloning the live fleet and
 * stepping on its state. The Makefile's `dev` target sets this to a path
 * inside the current worktree so each worktree gets its own sandbox.
 *
 * Safety behavior for the override:
 *   - **unset** → fall through to `$HOME/.autonomos` (prod default)
 *   - **empty string** → THROW (likely an unset shell var expanding to "" —
 *     silently falling through to prod is the exact bug this module exists to
 *     prevent)
 *   - **starts with `~/`** → expand using `$HOME`
 *   - **relative** → resolved against cwd at module-load time
 *   - **absolute** → used verbatim
 */

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function requireHome(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return home;
}

function resolveConfigDir(): string {
  const raw = process.env.AUTONOMOS_CONFIG_DIR;

  // Unset → default. Distinct from empty string (see below).
  if (raw === undefined) return join(requireHome(), ".autonomos");

  // Empty string → LOUD failure. This almost always means a shell variable
  // expanded to nothing (`AUTONOMOS_CONFIG_DIR=$UNSET`). Silently falling
  // through to ~/.autonomos would defeat the isolation guarantee.
  if (raw.length === 0) {
    throw new Error(
      "AUTONOMOS_CONFIG_DIR is set to an empty string — refusing to silently " +
        "fall back to ~/.autonomos. Unset the variable to use the default, " +
        "or set it to a real path.",
    );
  }

  // Expand leading `~/` or `~`. Node does not do shell tilde expansion, so
  // `AUTONOMOS_CONFIG_DIR=~/.autonomos` (unquoted in some shell contexts)
  // would otherwise create a literal `~` directory in cwd.
  if (raw === "~" || raw.startsWith("~/")) {
    return join(requireHome(), raw.slice(1));
  }

  return isAbsolute(raw) ? raw : resolve(raw);
}

export const CONFIG_DIR = resolveConfigDir();

/**
 * True when running against a non-default config dir. Call sites log this
 * at startup so the operator can see at a glance that a server is not
 * talking to `~/.autonomos/`.
 */
export const IS_OVERRIDDEN_CONFIG_DIR =
  process.env.AUTONOMOS_CONFIG_DIR !== undefined;

/**
 * Create the config dir if it does not exist. Throws with a clear message
 * if the path exists but is not a directory (e.g., a file) — callers
 * should invoke this once at startup so the failure is immediate and
 * logged, not deferred to the first write.
 */
export function ensureConfigDir(): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create config dir "${CONFIG_DIR}": ${msg}. ` +
        `Check AUTONOMOS_CONFIG_DIR — it must point to a writable directory ` +
        `or a path whose parents are writable.`,
    );
  }
}
