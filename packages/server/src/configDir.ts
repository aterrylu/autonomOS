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
const DEFAULT_CONFIG_DIR = join(HOME, ".autonomos");

export const CONFIG_DIR =
  process.env.AUTONOMOS_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR;

let _testOverride: string | null = null;

/** Returns the active config dir — test override if set, otherwise CONFIG_DIR. */
export function getConfigDir(): string {
  if (_testOverride) return _testOverride;
  // TEST-ESCAPE GUARD: a test process must NEVER resolve the production
  // config dir — that is how a fixture (status:"running", bypass-mode)
  // escaped into ~/.autonomos and was resurrected as a live agent by the
  // next upgrade's boot-resume. NODE_TEST_CONTEXT is set by `node --test` /
  // `tsx --test` in every test process. Crucially the check compares the
  // RESOLVED dir against the real default, not "is the env var set":
  // autonomOS sets AUTONOMOS_CONFIG_DIR=<real dir> in every spawned agent's
  // env, so a worker running the suite inherits an explicitly-set var that
  // STILL points at production — presence is not isolation. Env is read
  // LIVE (not the module-load snapshot) so suites that set an isolated dir
  // in a before-hook pass.
  const resolved =
    process.env.AUTONOMOS_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR;
  if (process.env.NODE_TEST_CONTEXT && resolved === DEFAULT_CONFIG_DIR) {
    throw new Error(
      "Test resolved the REAL config dir (~/.autonomos). Tests must isolate: " +
        "set AUTONOMOS_CONFIG_DIR to a temp dir before importing persistence " +
        "modules, or call _setConfigDirForTesting(mkdtemp(...)). Refusing to " +
        "read/write production agent state from a test process.",
    );
  }
  return resolved;
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    // 0700: the config root holds the auth token, agent records, schedules and
    // templates. Owner-only. Creation-time only (an existing dir keeps its
    // mode — the token file inside is 0600 regardless).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
