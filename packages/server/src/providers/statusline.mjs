#!/usr/bin/env node
/**
 * autonomOS statusline renderer.
 *
 * Spawned by Claude Code via the inline statusLine.command in --settings.
 * Reads CC session JSON on stdin, enriches with autonomOS hierarchy via
 * the local server REST API, and prints two lines to stdout:
 *
 *   Line 1: identity (autonomOS-aware, hierarchy-conditional)
 *   Line 2: activity (CC-native fields, conditional suffixes)
 *
 * This file ships as a standalone .mjs (no build step). It must rely only
 * on built-in Node modules and global fetch (Node 18+).
 *
 * Triggers (per CC docs):
 *   - After each new assistant message
 *   - On permission-mode change, vim-mode toggle (debounced 300ms)
 *   - Every 5 seconds via the refreshInterval set in claude-code.ts
 *
 * Failure contract: never crash. Always print *something* parseable; on any
 * error degrade to a static [autonomos] line so the terminal never goes blank.
 */

const FETCH_TIMEOUT_MS = 200;

// ── stdin helpers ─────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

// ── Network helpers ───────────────────────────────────────────

async function fetchJson(url, token) {
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── autonomOS context resolution ──────────────────────────────

/**
 * Resolve the autonomOS metadata for this session. Returns null if the
 * server is unreachable or the session isn't tracked.
 *
 * Uses the LIST endpoint /api/sessions because it enriches each record
 * with manager/template/project from persisted state. The single-session
 * endpoint /api/sessions/:id returns a bare Session without those fields,
 * so it can't answer "who is my manager" for the renderer.
 *
 * One fetch covers both queries: find self by `id` (the autonomOS session
 * id, NOT claudeSessionId — those are different fields), then filter the
 * same array for `manager === self.name` to count direct reports.
 *
 * Auth: AUTONOMOS_TOKEN is inherited from the autonomos process env when
 * CC spawns this script. Without it, /api/sessions returns 401.
 */
async function getAutonomosMeta(sessionId, serverUrl, token) {
  const sessions = await fetchJson(`${serverUrl}/api/sessions`, token);
  if (!Array.isArray(sessions)) return null;

  const me = sessions.find((s) => s?.id === sessionId);
  if (!me) return null;

  const name = me.name ?? "Agent";
  const directReports = sessions.filter(
    (s) => s?.manager === name && s?.status !== "exited",
  ).length;

  return {
    name,
    manager: me.manager ?? null,
    directReports,
  };
}

// ── Identity line ─────────────────────────────────────────────

/**
 * Format the identity portion of the statusline (line 1, bracketed).
 *
 * Renders agent name, then optional ↑manager and ↓N reports segments,
 * with a "standalone" tag when both are absent.
 *
 *   [Dispatcher@autonomos · ↓3 reports]
 *   [TeamLead@autonomos · ↑Dispatcher · ↓2 reports]
 *   [Worker@autonomos · ↑TeamLead]
 *   [Agent@autonomos · standalone]
 */
function formatHierarchy(ctx) {
  const segments = [ctx.name];
  const reports = ctx.directReports ?? 0;
  if (ctx.manager) {
    segments.push(`↑${ctx.manager}`);
  }
  if (reports > 0) {
    segments.push(`↓${reports} reports`);
  }
  if (!ctx.manager && reports <= 0) {
    segments.push("standalone");
  }
  return `[${segments.join(" · ")}]`;
}

// ── Activity line (provided) ──────────────────────────────────

function buildBar(pct, width = 10) {
  const safe = Math.max(0, Math.min(100, Math.floor(pct ?? 0)));
  const filled = Math.floor((safe * width) / 100);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function formatDuration(ms) {
  const sec = Math.floor((ms ?? 0) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function formatActivity(cc) {
  const model = cc?.model?.display_name ?? "?";
  const pct = cc?.context_window?.used_percentage ?? 0;
  const cost = cc?.cost?.total_cost_usd ?? 0;
  const dur = cc?.cost?.total_duration_ms ?? 0;
  const branch = cc?.workspace?.git_worktree ?? cc?.worktree?.branch ?? null;

  const parts = [
    `⚡${model}`,
    `${buildBar(pct)} ${Math.floor(pct)}%`,
    `$${cost.toFixed(2)}`,
    `⏱${formatDuration(dur)}`,
  ];
  if (branch) parts.push(`🌿 ${branch}`);
  return parts.join("  ");
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  let cc = {};
  try {
    const raw = await readStdin();
    cc = JSON.parse(raw);
  } catch {
    // stdin parse failure — fall through with empty cc
  }

  const sessionId = process.env.AUTONOMOS_SESSION_ID;
  const serverUrl = process.env.AUTONOMOS_SERVER;
  const token = process.env.AUTONOMOS_TOKEN;

  // Invoked outside autonomOS (env not injected) → no hierarchy to render
  if (!sessionId || !serverUrl) {
    console.log("[autonomos]");
    console.log(formatActivity(cc));
    return;
  }

  const meta = await getAutonomosMeta(sessionId, serverUrl, token);

  if (!meta) {
    // Env vars present but server unreachable / session not yet persisted —
    // surface as a diagnostic so it's distinguishable from "outside autonomOS"
    console.log("[autonomos · offline]");
    console.log(formatActivity(cc));
    return;
  }

  console.log(formatHierarchy(meta));
  console.log(formatActivity(cc));
}

// Only run main() when invoked directly (`node statusline.mjs`).
// Importing this file (e.g. from tests) shouldn't trigger CLI behavior.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/statusline.mjs");

if (isDirectInvocation) {
  main().catch(() => {
    // Last-resort guard — never crash the terminal
    console.log("[autonomos]");
  });
}

// Exposed for unit tests. Not part of any public contract.
export {
  buildBar,
  formatActivity,
  formatDuration,
  formatHierarchy,
  getAutonomosMeta,
};
