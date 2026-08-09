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
import { mintAgentToken } from "../agentCredentials.js";
import { getConfigDir } from "../configDir.js";
import { MCP_INSTRUCTIONS } from "../mcp/tools.js";
import {
  assertSpawnReady,
  getInternalSocketPath,
  getServerPort,
} from "../serverState.js";

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
//
// Goes over the internal Unix socket (ADR-055), NOT the public port. The
// hostname in the URL is a placeholder curl requires but never resolves —
// `--unix-socket` decides the destination, the URL only supplies the path.
//
// Deliberately NOT reusing AUTONOMOS_SERVER: that var is the PUBLIC base URL
// and is still read by statusline.mjs for /api/agents. One var serving both
// planes is what welded them together in the first place, so hooks get their
// own single-purpose AUTONOMOS_INTERNAL_SOCKET.
export const HOOK_CMD =
  'curl -sf --max-time 2 -X POST -H "Content-Type: application/json"' +
  // Per-agent identity (ADR-055 PR B): ${...} stays UNEXPANDED here — the agent's
  // shell substitutes it at hook time from env, so the token is never in argv.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' -H "X-Agent-Token: ${AUTONOMOS_AGENT_TOKEN}"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' --unix-socket "${AUTONOMOS_INTERNAL_SOCKET}"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' -d @- "http://localhost/api/hooks/${AUTONOMOS_SESSION_ID}"' +
  " >/dev/null 2>&1";

// ── Binary discovery helpers ─────────────────────────────────

const HOME = process.env.HOME || "/tmp";
if (!process.env.HOME) {
  console.warn(
    "[providers] $HOME is not set — binary candidate paths will use /tmp. " +
      "The launchd plist / systemd-user unit set HOME in the service env.",
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
 * Keep in sync with EXTRA_PATHS in scripts/install-prod-service.sh (which sets
 * the launchd/systemd-user service PATH).
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
 * Env keys the runtime manages directly and no user/agent-supplied source
 * (customEnvVars OR an env preset) may override. Repointing any of these would
 * either break the hook relay / control plane or let an agent forge its
 * identity, so they are stripped from every merge. Single source of truth,
 * consumed by claude-code's customEnvVars merge, the env-preset injection in
 * runtime.ts, and env-preset validation in envPresets.ts.
 */
export const RESERVED_ENV_KEYS = new Set([
  "CLAUDECODE",
  "PORT",
  "PATH",
  "HOME",
  "AUTONOMOS_SERVER",
  "AUTONOMOS_INTERNAL_SOCKET",
  "AUTONOMOS_SESSION_ID",
  "AUTONOMOS_AGENT_NAME",
  "AUTONOMOS_AGENT_TOKEN",
  "AUTONOMOS_CONFIG_DIR",
]);

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
  // Perf-harness mode must not propagate: an agent that later launches its own
  // autonomOS server (make dev/prod) would silently inherit the auth bypass.
  delete env.AUTONOMOS_PERF;

  env.PATH = [...BINARY_DIRS, env.PATH].join(":");
  delete env.PORT;

  // Assert BOTH spawn preconditions up front, as one typed failure.
  //
  // This is the funnel every spawn path goes through, so it is the right place
  // to decide what a too-early spawn sees. Relying on the individual getters
  // below is fragile: getInternalSocketPath() throws the typed error (→ 503),
  // getServerPort() throws a bare Error (→ 500), so the status would depend on
  // which one happens to be missing AND on the order these two statements
  // appear in. Asserting first makes the retryable 503 unconditional.
  assertSpawnReady();

  // INTERNAL control plane. Consumed by HOOK_CMD's `curl --unix-socket`.
  // Single-purpose on purpose (ADR-055): the two planes no longer share a var.
  env.AUTONOMOS_INTERNAL_SOCKET = getInternalSocketPath();
  // PUBLIC base URL. Consumed by statusline.mjs (/api/agents) — a read of the
  // browser-facing surface, so it must stay an http:// URL on the real port.
  env.AUTONOMOS_SERVER = `http://localhost:${getServerPort()}`;
  env.AUTONOMOS_SESSION_ID = sessionId;
  env.AUTONOMOS_AGENT_NAME = agentName;
  // Set the config dir explicitly (getConfigDir() defaults to ~/.autonomos when
  // AUTONOMOS_CONFIG_DIR is unset, which is the prod case). The channel-server
  // needs it — with AUTONOMOS_SESSION_ID — to derive its token-file path
  // (`<configDir>/agent-tokens/<sessionId>`), and both are non-secret names
  // every provider propagates, unlike the token itself which Gemini filters.
  env.AUTONOMOS_CONFIG_DIR = getConfigDir();
  // Per-agent identity — HOOK path only. HOOK_CMD sends this as X-Agent-Token so
  // hook ingest can verify the POST is for THIS agent's own session; the curl
  // references ${AUTONOMOS_AGENT_TOKEN} unexpanded, so the value stays in env,
  // never in argv. The CHANNEL-SERVER gets the SAME token by a different route —
  // the per-session file (writeAgentTokenFile at spawn) — because env doesn't
  // reach Gemini's MCP subprocess and argv is world-readable for Codex. One
  // token, two delivery paths; see agentCredentials.ts.
  env.AUTONOMOS_AGENT_TOKEN = mintAgentToken(sessionId);

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
