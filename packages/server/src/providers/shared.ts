/**
 * Shared constants and helpers used across all agent providers.
 *
 * Centralises BASE_CONTEXT, HOOK_CMD, binary resolution, and
 * common environment variable setup so each provider only defines
 * what makes it unique.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MCP_INSTRUCTIONS } from "../mcp/tools.js";
import { getServerPort } from "../serverState.js";

// ── Base context injected into every spawned agent session ────
export const BASE_CONTEXT = `You are running inside autonomOS — an agent orchestration platform that manages \
AI coding agents for personal and enterprise use.

## Your Identity

You are a named agent in an organization. Other agents and the human operator \
can see you by name, send you messages, and observe your status. You may have \
a manager, peers, and direct reports — use get_org_chart() to see the hierarchy.

## Communication

${MCP_INSTRUCTIONS}

Messages are asynchronous — the recipient may be busy or idle. Do not block \
waiting for a response. Continue your work and handle replies when they arrive.

## Environment

- A human operator monitors all agents via a server dashboard, seeing status \
and notifications. You do not need to over-report — they can see your terminal.
- You may share a codebase with other agents. Some projects use the main branch \
(single agent), others use worktrees for isolation (multiple agents).
- You cannot access another agent's terminal or read their output directly. \
All inter-agent communication goes through send().

## Lifecycle

Some agents are long-lived (team leads, persistent roles). Others are spawned \
for a specific task — once the work is done and the PR is merged, they exit. \
Your session persists across server restarts until you, the human operator, or \
a managing agent (such as your manager or a superior) ends it.`;

// ── Hook relay command (shared curl template, session-specific via env vars) ──
// Posts event JSON to /api/hooks via curl. No trailing & — most CLIs handle
// backgrounding via their own async mechanism.
export const HOOK_CMD =
  'curl -sf --max-time 2 -X POST -H "Content-Type: application/json"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' -d @- "${AUTONOMOS_SERVER}/api/hooks/${AUTONOMOS_SESSION_ID}"' +
  " >/dev/null 2>&1";

// ── Claude-session harvest command (claude-code SessionStart only) ──
// Relays Claude Code's CLAUDE_SESSION_COOKIE to the usage plugin so it works
// with no manual paste. The cookie is expanded by the shell and piped to
// curl's stdin — it never appears in any process argv. Best-effort and silent;
// the server holds it in memory only and ignores it when auto-detect is off.
export const COOKIE_RELAY_CMD =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  '[ -n "${CLAUDE_SESSION_COOKIE}" ] && ' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  'printf %s "${CLAUDE_SESSION_COOKIE}" | ' +
  "curl -sf --max-time 2 -X POST --data-binary @- " +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  '"${AUTONOMOS_SERVER}/api/plugins/claude-usage/session" >/dev/null 2>&1 || true';

// ── Binary discovery helpers ─────────────────────────────────

const HOME = process.env.HOME || "/tmp";
if (!process.env.HOME) {
  console.warn(
    "[providers] $HOME is not set — binary candidate paths will use /tmp. " +
      "Set HOME in ecosystem.config.cjs env if running under PM2.",
  );
}

/**
 * Find the latest nvm-managed Node bin directory (if nvm is installed).
 * Returns the bin dir of the highest semver version, or undefined.
 */
function findNvmNodeBin(): string | undefined {
  const nvmDir = join(HOME, ".nvm/versions/node");
  try {
    const versions = readdirSync(nvmDir)
      .filter((d) => d.startsWith("v"))
      .sort((a, b) => {
        const pa = a.slice(1).split(".").map(Number);
        const pb = b.slice(1).split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
        }
        return 0;
      });
    if (versions.length > 0) return join(nvmDir, versions[0], "bin");
  } catch (err: unknown) {
    if (
      !(err instanceof Error) ||
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      console.warn("[providers] unexpected error scanning nvm versions:", err);
    }
  }
  return undefined;
}

/**
 * Well-known directories where CLI binaries are commonly installed.
 * Computed once at module load. Includes nvm if present on disk.
 * Used for both PATH enrichment and direct binary candidate resolution.
 * Keep in sync with EXTRA_PATHS in ecosystem.config.cjs.
 */
const BINARY_DIRS: readonly string[] = (() => {
  const dirs = [
    join(HOME, ".local/bin"),
    join(HOME, ".bun/bin"),
    join(HOME, ".npm-global/bin"),
    join(HOME, ".cargo/bin"),
    join(HOME, ".volta/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/snap/bin",
    "/usr/bin",
  ];
  const nvmBin = findNvmNodeBin();
  if (nvmBin) dirs.splice(2, 0, nvmBin);
  return dirs;
})();

/**
 * Generate common filesystem candidate paths for a CLI binary.
 * Each provider can extend this with provider-specific paths.
 */
export function commonBinaryCandidates(binaryName: string): string[] {
  return BINARY_DIRS.map((dir) => join(dir, binaryName));
}

/**
 * Build the common base environment for any provider.
 * Prepends well-known binary directories to PATH and sets AUTONOMOS_* vars.
 * Providers can extend the returned env with provider-specific vars.
 */
export function buildBaseEnv(
  sessionId: string,
  agentName: string,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;

  // Strip the host Claude Code session identity before it reaches the agent.
  // When the autonomOS server is itself launched from inside a CC session
  // (e.g. `make prod` run from a CC terminal), it inherits CLAUDE_CODE_* /
  // CLAUDECODE and would re-broadcast them into every spawned agent.
  // CLAUDE_CODE_EXECPATH pins the agent's `claude` to the parent CLI version;
  // CLAUDE_CODE_SESSION_ID collides with the per-agent --session-id flag.
  // NOTE: do NOT touch ANTHROPIC_* — #214 relies on those passing through.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  delete env.CLAUDECODE;

  env.PATH = [...BINARY_DIRS, env.PATH].join(":");
  delete env.PORT;

  env.AUTONOMOS_SERVER = `http://localhost:${getServerPort()}`;
  env.AUTONOMOS_SESSION_ID = sessionId;
  env.AUTONOMOS_AGENT_NAME = agentName;

  return env;
}

/**
 * Resolve a CLI binary by checking well-known paths then falling back to `which`.
 * Caches the result for subsequent calls.
 */
export function resolveBinaryFromCandidates(
  binaryName: string,
  candidates: string[],
  cache: { path: string | null },
): string {
  if (cache.path) return cache.path;

  for (const p of candidates) {
    if (existsSync(p)) {
      cache.path = p;
      return p;
    }
  }

  try {
    const which = execFileSync("which", [binaryName], {
      encoding: "utf-8",
    }).trim();
    if (which) {
      cache.path = which;
      return which;
    }
  } catch {
    // not in PATH
  }

  throw new Error(
    `${binaryName} binary not found. Searched: ${candidates.join(", ")} and PATH`,
  );
}

/**
 * Build the system prompt from BASE_CONTEXT + optional append.
 * Used by providers that support --append-system-prompt or equivalent.
 */
export function buildSystemPrompt(
  systemPrompt: string | undefined,
  appendSystemPrompt: string | undefined,
): string {
  if (systemPrompt) return systemPrompt;

  const parts: string[] = [BASE_CONTEXT];
  if (appendSystemPrompt) {
    parts.push("", "---", "", appendSystemPrompt);
  }
  return parts.join("\n");
}
