/**
 * Auth token resolution — always-on authentication for autonomOS.
 *
 * Resolution order:
 * 1. AUTONOMOS_TOKEN env var (explicit override)
 * 2. ~/.autonomos/token file (auto-generated on first run)
 * 3. Generate a new random token, write to ~/.autonomos/token
 *
 * The token file is always in ~/.autonomos/ (not CONFIG_DIR) because
 * CONFIG_DIR can be overridden per-worktree for dev isolation, but the
 * auth token should be shared — one token for the user's machine.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");

const TOKEN_DIR = join(HOME, ".autonomos");
const TOKEN_FILE = join(TOKEN_DIR, "token");

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

  // 2. Read from file
  try {
    if (existsSync(TOKEN_FILE)) {
      const fileToken = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (fileToken) return fileToken;
    }
  } catch (err) {
    console.warn(
      `Cannot read auth token from ${TOKEN_FILE}: ${err instanceof Error ? err.message : err}. Generating new token.`,
    );
  }

  // 3. Generate and persist
  const token = randomBytes(32).toString("hex");
  try {
    if (!existsSync(TOKEN_DIR)) {
      mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    console.log(`Generated auth token → ${TOKEN_FILE}`);
  } catch (err) {
    console.warn(
      `Failed to write auth token to ${TOKEN_FILE}: ${err instanceof Error ? err.message : err}. Using ephemeral token for this session.`,
    );
  }
  return token;
}
