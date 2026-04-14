/**
 * Shared constants and helpers used across all agent providers.
 *
 * Centralises BASE_CONTEXT, HOOK_CMD, binary resolution, and
 * common environment variable setup so each provider only defines
 * what makes it unique.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MCP_INSTRUCTIONS } from "../mcp/tools.js";

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

// ── Common PATH extensions ───────────────────────────────────
const EXTRA_PATH_DIRS = [
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.bun/bin`,
  "/usr/local/bin",
];

/**
 * Build the common base environment for any provider.
 * Sets up PATH extensions and AUTONOMOS_* identification vars.
 * Providers can extend the returned env with provider-specific vars.
 */
export function buildBaseEnv(
  sessionId: string,
  agentName: string,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.PATH = [...EXTRA_PATH_DIRS, env.PATH].join(":");
  delete env.PORT;

  const port = process.env.PORT || "3000";
  env.AUTONOMOS_SERVER = `http://localhost:${port}`;
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
