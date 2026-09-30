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

/**
 * How the operator token may appear in the boot banner, which is teed into the
 * log file (V8). Never enough to reconstruct it: the old `first4...last4` WAS
 * the whole token when it had 8 chars or fewer. A long token shows its last 4
 * (enough to tell two tokens apart). A short one shows only its length: 4
 * chars of a 12-char token is a third of it.
 */
export function describeTokenForLog(token: string): string {
  if (token.length >= 16)
    return `…${token.slice(-4)} (${token.length} chars; the full value is never logged)`;
  return `(hidden, ${token.length} chars)`;
}

/** Where the operator token came from. */
export type TokenSource = "env" | "file" | "legacy-file" | "generated";

/**
 * A token this short (or this repetitive) can be guessed online, even through
 * the V2 throttle: 300 guesses/min globally takes a 4-char hex token in hours.
 * Every token autonomOS generates is 64 hex chars; weak ones come only from an
 * operator-set AUTONOMOS_TOKEN or a hand-written token file.
 */
export const MIN_TOKEN_LENGTH = 32;
export function isWeakToken(token: string): boolean {
  return token.length < MIN_TOKEN_LENGTH || new Set(token).size < 8;
}

/**
 * Had this config dir been used by a server before THIS boot? Call before the
 * boot creates anything in it (logs/, templates/, agents/). The token file is
 * deliberately not a marker: an operator can hand-write one before the first
 * boot, and that is still a new install.
 */
export function isPriorInstall(configDir: string): boolean {
  return ["agents", "templates", "logs", "settings.json"].some((m) =>
    existsSync(join(configDir, m)),
  );
}

/**
 * What to do about the token at boot (V2b, ADR-127). Existing installs are
 * never refused: upgrades never break auth. They get a warning on every boot
 * and a dashboard banner. A NEW install that would put a weak token on a
 * network bind refuses to start, unless the operator explicitly opts in.
 */
export function weakTokenPolicy(o: {
  weak: boolean;
  priorInstall: boolean;
  networkBind: boolean;
  allowWeak: boolean;
}): "ok" | "warn" | "refuse" {
  if (!o.weak) return "ok";
  if (!o.priorInstall && o.networkBind && !o.allowWeak) return "refuse";
  return "warn";
}

export function resolveAuthToken(): string {
  return resolveAuthTokenWithSource().token;
}

export function resolveAuthTokenWithSource(): {
  token: string;
  source: TokenSource;
} {
  // 1. Env var takes precedence
  const envToken = process.env.AUTONOMOS_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };

  // 2. Per-config-dir token (when CONFIG_DIR != default). Isolated
  //    profiles get isolated tokens. When CONFIG_DIR IS the default, this
  //    path equals DEFAULT_TOKEN_FILE — same behavior as before this change.
  const configDir = getConfigDir();
  const configToken = join(configDir, "token");

  try {
    if (existsSync(configToken)) {
      const fileToken = readFileSync(configToken, "utf-8").trim();
      if (fileToken) return { token: fileToken, source: "file" };
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
      if (fileToken) return { token: fileToken, source: "legacy-file" };
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
  return { token, source: "generated" };
}
