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

import { execFileSync } from "node:child_process";

const FETCH_TIMEOUT_MS = 200;
const GIT_TIMEOUT_MS = 100;

// ── ANSI colors ───────────────────────────────────────────────
// Single place to tweak the palette. Edit values here, the next 5s
// refresh tick picks them up — no restart needed.

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  // Identity colors
  agent: "\x1b[1;36m", // bright cyan — agent name (the "who am I" anchor)
  project: "\x1b[38;2;103;164;250m", // RGB(103, 164, 250) — Terry's chosen blue
  hierarchy: "\x1b[36m", // cyan (non-bold) — ↑manager and ↓N reports arrows
  bracket: "\x1b[2;37m", // dim grey — outer [ ] and · separators
  standalone: "\x1b[2;37m", // dim grey — "standalone" tag
  // Activity colors
  model: "\x1b[95m", // bright magenta — ⚡Model (distinct from yellow cost on its left)
  ctxLow: "\x1b[32m", // green — context bar < 70%
  ctxMid: "\x1b[33m", // yellow — context bar 70-89%
  ctxHigh: "\x1b[31m", // red — context bar 90%+
  cost: "\x1b[33m", // yellow — usage/cost, per Terry's preference
  duration: "\x1b[2;37m", // dim grey — duration (low signal)
  branch: "\x1b[32m", // green — branch, per Terry's preference
  separator: "\x1b[2;37m", // dim grey — │ between segments
};

const SEP = ` ${C.separator}│${C.reset} `;

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
/**
 * Strip control characters (ANSI escape, CR/LF/BS/etc.) from agent-supplied
 * strings before they get rendered. A malicious peer agent or buggy spawn
 * could include `\x1b[2J` (clear screen) in a name and corrupt the user's
 * terminal on every refresh tick. Sanitize once at the boundary.
 */
function sanitize(s) {
  if (typeof s !== "string") return s;
  // First strip whole CSI escape sequences (ESC [ ... terminator) — without
  // the terminator, dropping just ESC would leave visible `[2J` literal text
  // that's confusing but safe. Then strip any remaining C0 control chars.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching ANSI/control chars to strip them
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]?/g, "").replace(/[\x00-\x1f\x7f]/g, "");
}

async function getAutonomosMeta(sessionId, serverUrl, token) {
  // The API replaced /api/sessions with /api/agents (PR #165 unified the
  // Agent + Session models). Manager refs are now by UUID (managerId), not
  // by name — we resolve the manager's display name by looking up the
  // referenced agent in the same response.
  const agents = await fetchJson(`${serverUrl}/api/agents`, token);
  if (!Array.isArray(agents)) return null;

  const me = agents.find((a) => a?.id === sessionId);
  if (!me) return null;

  const managerName = me.managerId
    ? (agents.find((a) => a?.id === me.managerId)?.name ?? null)
    : null;

  const directReports = agents.filter(
    (a) => a?.managerId === me.id && a?.status !== "exited",
  ).length;

  return {
    name: sanitize(me.name) ?? "Agent",
    manager: sanitize(managerName),
    project: sanitize(me.project) ?? null,
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
function colorizeName(name) {
  // Split "Worker@autonomos" into agent + project segments so we can color
  // them independently. Names without @ render entirely in agent color.
  const at = name.indexOf("@");
  if (at < 0) return `${C.agent}${name}${C.reset}`;
  const role = name.slice(0, at);
  const project = name.slice(at); // includes the @
  return `${C.agent}${role}${C.project}${project}${C.reset}`;
}

function formatHierarchy(ctx) {
  const reports = ctx.directReports ?? 0;
  const segments = [colorizeName(ctx.name)];
  if (ctx.manager) {
    segments.push(`${C.hierarchy}↑${ctx.manager}${C.reset}`);
  }
  if (reports > 0) {
    segments.push(`${C.hierarchy}↓${reports} reports${C.reset}`);
  }
  if (!ctx.manager && reports <= 0) {
    segments.push(`${C.standalone}standalone${C.reset}`);
  }
  const sep = `${C.bracket} · ${C.reset}`;
  return `${C.bracket}[${C.reset}${segments.join(sep)}${C.bracket}]${C.reset}`;
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

function ctxColor(pct) {
  if (pct >= 90) return C.ctxHigh;
  if (pct >= 70) return C.ctxMid;
  return C.ctxLow;
}

/**
 * Resolve the git branch for the current cwd.
 *
 * CC's stdin only populates branch fields for sessions inside a git
 * worktree (workspace.git_worktree) or --worktree sessions (worktree.branch).
 * For the much-more-common case of a session in a regular repo's main
 * working tree, both are absent — so we fall back to `git branch
 * --show-current` against the cwd CC tells us about. execFileSync (not
 * exec) avoids any shell so cwd can't be shell-injected.
 */
function resolveBranch(cc) {
  if (cc?.workspace?.git_worktree) return cc.workspace.git_worktree;
  if (cc?.worktree?.branch) return cc.worktree.branch;

  const cwd = cc?.workspace?.current_dir ?? cc?.cwd;
  if (!cwd || typeof cwd !== "string") return null;

  try {
    const out = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      // Bound discovery so a misconfigured cwd (e.g. inside a network mount)
      // can't make git stat its way up the entire ancestor chain on every
      // 5s tick. cwd itself is the ceiling — git only checks cwd's .git.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: cwd },
    }).trim();
    return out || null;
  } catch {
    return null; // not a repo, git not installed, or timeout — drop segment
  }
}

/**
 * Resolve the project name to display. Falls back through:
 *   1. autonomOS metadata (`meta.project` — set when agent was spawned)
 *   2. The `@project` segment of the agent's display name
 *   3. The basename of CC's project_dir / cwd (the directory CC launched in)
 *
 * Returns null if nothing useful can be derived (segment dropped).
 */
function resolveProject(cc, meta) {
  if (meta?.project) return meta.project;

  const name = meta?.name;
  if (name && typeof name === "string") {
    const at = name.indexOf("@");
    if (at >= 0 && at < name.length - 1) return name.slice(at + 1);
  }

  // Use project_dir strictly first (CC's notion of where the project root is).
  // Falling through to current_dir/cwd produces wrong labels when the user has
  // cd'd into a subdirectory — e.g. "providers" instead of "autonomOS".
  const dir = cc?.workspace?.project_dir ?? cc?.cwd;
  if (dir && typeof dir === "string") {
    const base = dir.split("/").filter(Boolean).pop();
    if (base) return base;
  }

  return null;
}

function formatActivity(cc, meta) {
  const project = resolveProject(cc, meta);
  const branch = resolveBranch(cc);
  const cost = cc?.cost?.total_cost_usd ?? 0;
  const model = cc?.model?.display_name ?? "?";
  const pct = cc?.context_window?.used_percentage ?? 0;
  const dur = cc?.cost?.total_duration_ms ?? 0;

  const ctxC = ctxColor(pct);
  // Order mirrors the personal CC statusline: project → branch → usage,
  // followed by autonomOS-specific extras (model, ctx bar, duration).
  const parts = [];
  if (project) parts.push(`${C.project}${project}${C.reset}`);
  if (branch) parts.push(`${C.branch}🌿 ${branch}${C.reset}`);
  parts.push(`${C.cost}$${cost.toFixed(2)}${C.reset}`);
  parts.push(`${C.model}⚡${model}${C.reset}`);
  parts.push(`${ctxC}${buildBar(pct)} ${Math.floor(pct)}%${C.reset}`);
  parts.push(`${C.duration}⏱${formatDuration(dur)}${C.reset}`);
  return parts.join(SEP);
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
    console.log(formatActivity(cc, null));
    return;
  }

  const meta = await getAutonomosMeta(sessionId, serverUrl, token);

  if (!meta) {
    // Env vars present but server unreachable / session not yet persisted —
    // surface as a diagnostic so it's distinguishable from "outside autonomOS"
    console.log("[autonomos · offline]");
    console.log(formatActivity(cc, meta));
    return;
  }

  console.log(formatHierarchy(meta));
  console.log(formatActivity(cc, meta));
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
