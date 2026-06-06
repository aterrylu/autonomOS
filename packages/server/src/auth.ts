/**
 * Auth token resolution — always-on authentication for autonomOS.
 *
 * Resolution order:
 * 1. AUTONOMOS_TOKEN env var (explicit override)
 * 2. <CONFIG_DIR>/token file (when AUTONOMOS_CONFIG_DIR is set — isolated profiles)
 * 3. ~/.autonomos/token file (the user's shared "production" token, legacy fallback)
 * 4. Generate a new random token, write to whichever dir is active
 *
 * Pre-2026-06: token always lived in ~/.autonomos/token regardless of
 * CONFIG_DIR. That worked for worktree-based dev isolation (one user, many
 * worktrees, shared token) but breaks the Desktop's "Try it out" / sandbox
 * mode where the whole point is isolation. When CONFIG_DIR points to a
 * non-default location, we honor it for the token too. Default CONFIG_DIR
 * still resolves to ~/.autonomos/token — fully backwards-compatible.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");

const DEFAULT_TOKEN_DIR = join(HOME, ".autonomos");
const DEFAULT_TOKEN_FILE = join(DEFAULT_TOKEN_DIR, "token");

export function resolveAuthToken(): string {
  // 1. Env var takes precedence
  const envToken = process.env.AUTONOMOS_TOKEN?.trim();
  if (envToken) {
    if (envToken.length < 8) {
      console.warn(
        `AUTONOMOS_TOKEN is only ${envToken.length} chars — consider using a longer token.`,
      );
    }
    return envToken;
  }

  // 2. Per-config-dir token (when CONFIG_DIR != default). Isolated
  //    profiles get isolated tokens. When CONFIG_DIR IS the default, this
  //    path equals DEFAULT_TOKEN_FILE — same behavior as before this change.
  const configDir = getConfigDir();
  const configToken = join(configDir, "token");

  try {
    if (existsSync(configToken)) {
      const fileToken = readFileSync(configToken, "utf-8").trim();
      if (fileToken) return fileToken;
    }
  } catch (err) {
    console.warn(
      `Cannot read auth token from ${configToken}: ${err instanceof Error ? err.message : err}. Generating new token.`,
    );
  }

  // 3. Legacy fallback: when CONFIG_DIR is non-default AND no per-config
  //    token exists, fall through to ~/.autonomos/token so a freshly
  //    isolated CONFIG_DIR doesn't surprise the user with auth failures
  //    against existing tools. Skipped when CONFIG_DIR IS the default —
  //    no need to re-check the same path.
  if (configDir !== DEFAULT_TOKEN_DIR && existsSync(DEFAULT_TOKEN_FILE)) {
    try {
      const fileToken = readFileSync(DEFAULT_TOKEN_FILE, "utf-8").trim();
      if (fileToken) return fileToken;
    } catch {
      // Ignore — fall through to generate.
    }
  }

  // 4. Generate and persist into the active config dir
  const token = randomBytes(32).toString("hex");
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(configToken, token, { mode: 0o600 });
    console.log(`Generated auth token → ${configToken}`);
  } catch (err) {
    console.warn(
      `Failed to write auth token to ${configToken}: ${err instanceof Error ? err.message : err}. Using ephemeral token for this session.`,
    );
  }
  return token;
}
