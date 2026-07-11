/**
 * Resolve the Codex home directory — the root that holds `auth.json`,
 * `config.toml`, and the `sessions/` rollout tree.
 *
 * Mirrors the Codex CLI's own resolution: the `CODEX_HOME` env override wins,
 * otherwise `~/.codex`. Kept as a tiny seam so every reader (auth, config,
 * rollout scanner) resolves the same root and tests can point it at a fixture
 * dir via `CODEX_HOME` without touching the real `~/.codex`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The Codex home dir: `$CODEX_HOME` (trimmed, if set) else `~/.codex`. */
export function codexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.CODEX_HOME?.trim();
  return override || join(home, ".codex");
}
