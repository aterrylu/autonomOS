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

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// A fresh process pays undici's cold start (25-280ms measured under a busy
// box) before the request even leaves, so the old 200ms budget flipped
// healthy agents to "offline". The last-known-good cache below means a slow
// answer costs nothing visible, so the wait can be generous.
const FETCH_TIMEOUT_MS = 1500;
// Last-known-good identity is shown as-is for this long after the last fresh
// answer, then dimmed, and only reads "offline" after OFFLINE_AFTER_MS (or at
// once on a definitive answer: refused connection, 401, 404).
const STALE_AFTER_MS = 60_000;
const OFFLINE_AFTER_MS = 300_000;
// How stale the cached metaAt may get before a fresh answer rewrites it.
const CACHE_REFRESH_MS = 15_000;
// Bound on the .git search walking up from the cwd (see readGitBranch).
const GIT_WALK_MAX = 64;

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

// ── autonomOS context resolution ──────────────────────────────

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

/**
 * Per-agent credential, the #297 contract: the server writes
 * <configDir>/agent-tokens/<sessionId> at spawn (0600) and the PTY env
 * carries AUTONOMOS_CONFIG_DIR + AUTONOMOS_SESSION_ID (non-secret) to derive
 * the path; AUTONOMOS_AGENT_TOKEN is the env fallback where a provider
 * injects it. Session id is validated before use as a path segment.
 */
function readAgentToken(sessionId) {
  const configDir = process.env.AUTONOMOS_CONFIG_DIR;
  const valid =
    typeof sessionId === "string" &&
    /^[A-Za-z0-9._-]+$/.test(sessionId) &&
    !sessionId.includes("..");
  if (configDir && valid) {
    try {
      return readFileSync(join(configDir, "agent-tokens", sessionId), "utf8").trim();
    } catch {
      // fall through to env
    }
  }
  return process.env.AUTONOMOS_AGENT_TOKEN;
}

/**
 * Self-metadata via the agent-token-scoped endpoint. The only path: agents
 * never hold the operator token (#297 took it off the PTY, audit V3 off argv
 * and the inherited env), so this is the credential they have.
 */
async function fetchSelf(sessionId, serverUrl, agentToken) {
  if (!agentToken) return { error: "no-token" };
  try {
    const res = await fetch(`${serverUrl}/api/agents/${sessionId}/self`, {
      headers: { "X-Agent-Token": agentToken },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: "http", status: res.status };
    let me;
    try {
      me = await res.json();
    } catch {
      return { error: "bad-body" }; // something else answered on the port
    }
    if (!me || typeof me !== "object") return { error: "bad-body" };
    return {
      meta: {
        name: sanitize(me.name) ?? "Agent",
        manager: me.manager ? sanitize(me.manager) : null,
        project: me.project ? sanitize(me.project) : null,
        directReports: Number(me.directReports) || 0,
      },
    };
  } catch (err) {
    // undici reports a refused connection as TypeError("fetch failed") with
    // the errno on `cause`; a timeout is an AbortSignal TimeoutError.
    if (err?.cause?.code === "ECONNREFUSED") return { error: "refused" };
    if (err?.name === "TimeoutError") return { error: "timeout" };
    return { error: "other" };
  }
}

async function getSelfMeta(sessionId, serverUrl, agentToken) {
  return (await fetchSelf(sessionId, serverUrl, agentToken)).meta ?? null;
}

/**
 * Decide what the identity line shows, from this tick's fetch result and the
 * agent's last-known-good cache. Pure, so the policy is unit-tested directly.
 *
 * A slow or failed answer is NOT evidence the server is gone (a busy box makes
 * a fresh process's first request slow), so the last good answer stands until
 * it is genuinely old. Only a definitive answer ends it at once: a refused
 * connection (nothing listening), or a 401/404 (the server no longer knows
 * this agent).
 *
 * @returns {{kind: "fresh", meta: object}
 *   | {kind: "cached", meta: object, stale: boolean}
 *   | {kind: "offline"}}
 */
function chooseIdentity(result, cache, now) {
  if (result.meta) return { kind: "fresh", meta: result.meta };
  const definitive =
    result.error === "refused" ||
    (result.error === "http" &&
      (result.status === 401 || result.status === 404));
  if (definitive || !cache?.meta || typeof cache.metaAt !== "number")
    return { kind: "offline" };
  const age = now - cache.metaAt;
  if (age < 0 || age >= OFFLINE_AFTER_MS) return { kind: "offline" };
  return { kind: "cached", meta: cache.meta, stale: age >= STALE_AFTER_MS };
}

// ── Last-known-good cache ─────────────────────────────────────

/** Per-agent cache file, beside the agent's token file (same validated
 *  session id as the path segment). null when it can't be placed safely. */
function cachePath(sessionId) {
  const configDir = process.env.AUTONOMOS_CONFIG_DIR;
  if (
    !configDir ||
    typeof sessionId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(sessionId) ||
    sessionId.includes("..")
  )
    return null;
  return join(configDir, "statusline-cache", `${sessionId}.json`);
}

function readCache(path) {
  if (!path) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (!c || typeof c !== "object") return null;
    // A hand-edited or truncated file must not crash the renderer later.
    if (c.meta && typeof c.meta.name !== "string") delete c.meta;
    return c;
  } catch {
    return null;
  }
}

/** Best-effort atomic write: two ticks of the same agent can overlap, so
 *  write a private temp file and rename it into place. */
function writeCache(path, cache) {
  if (!path) return;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Read-only or sandboxed config dir (or a full disk): run without a cache.
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
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

function formatHierarchy(ctx, { stale = false } = {}) {
  const reports = ctx.directReports ?? 0;
  if (stale) {
    // Last-known-good but old: the same text, all dim, so it reads as "as of
    // a while ago" without pretending to be live.
    const parts = [ctx.name];
    if (ctx.manager) parts.push(`↑${ctx.manager}`);
    if (reports > 0) parts.push(`↓${reports} reports`);
    if (!ctx.manager && reports <= 0) parts.push("standalone");
    return `${C.dim}[${parts.join(" · ")}]${C.reset}`;
  }
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
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

function ctxColor(pct) {
  if (pct >= 90) return C.ctxHigh;
  if (pct >= 70) return C.ctxMid;
  return C.ctxLow;
}

/**
 * Read the checked-out branch straight from `.git/HEAD`, walking up from
 * `cwd` but never above `ceiling` (CC's project_dir when cwd is inside it,
 * else cwd itself), at most GIT_WALK_MAX levels.
 *
 * No `git` process: spawning one per agent every 5s missed its 100ms budget
 * in 96% of ticks on a loaded box, which is what made the branch flicker. A
 * linked worktree has a `.git` FILE (`gitdir: <path>`) pointing at its own
 * HEAD, which is followed. Returns the branch, or null when there is no repo
 * or HEAD is detached (matching `git branch --show-current`). Throws on an
 * unexpected I/O error so the caller can fall back to the cached branch.
 */
function readGitBranch(cwd, ceiling) {
  let dir = resolve(cwd);
  const stop = ceiling ? resolve(ceiling) : dir;
  const inside = (d) => {
    const rel = relative(stop, d);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
  };
  for (let i = 0; i < GIT_WALK_MAX; i++) {
    const dotGit = join(dir, ".git");
    let st = null;
    try {
      st = statSync(dotGit);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m) return null;
        gitDir = resolve(dir, m[1].trim());
      }
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      // reftable repos park HEAD at "refs/heads/.invalid": no branch to show.
      return ref && ref[1] !== ".invalid" ? ref[1] : null;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === stop || !inside(parent)) return null;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the git branch for the current cwd: CC's own fields first (only
 * set for worktree sessions), then `.git/HEAD`. On a read error the
 * last-known branch is reused; `cachedBranch` is that fallback.
 */
function resolveBranch(cc, cachedBranch = null, onFallback = () => {}) {
  if (cc?.workspace?.git_worktree) return cc.workspace.git_worktree;
  if (cc?.worktree?.branch) return cc.worktree.branch;

  const cwd = cc?.workspace?.current_dir ?? cc?.cwd;
  if (!cwd || typeof cwd !== "string") return null;
  const projectDir = cc?.workspace?.project_dir;
  const ceiling =
    typeof projectDir === "string" &&
    !relative(projectDir, cwd).startsWith("..")
      ? projectDir
      : cwd;
  try {
    return readGitBranch(cwd, ceiling);
  } catch {
    onFallback();
    return cachedBranch;
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

function formatActivity(cc, meta, branch = resolveBranch(cc)) {
  const project = resolveProject(cc, meta);
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
  parts.push(`${C.duration}⏱ ${formatDuration(dur)}${C.reset}`);
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
  // The PER-AGENT credential (token file, env fallback), consumed by the
  // /api/agents/:id/self endpoint. Agents are never given the operator token.
  const agentToken = readAgentToken(sessionId);

  // Invoked outside autonomOS (env not injected) → no hierarchy to render
  if (!sessionId || !serverUrl) {
    console.log("[autonomos]");
    console.log(formatActivity(cc, null));
    return;
  }

  // Start the request first; the branch read (plain file I/O) runs while it
  // is in flight.
  const now0 = Date.now();
  const pending = fetchSelf(sessionId, serverUrl, agentToken);
  const path = cachePath(sessionId);
  const cache = readCache(path);
  // The cached branch only stands in for a failed read briefly: a worktree
  // that was pruned must stop showing its old branch.
  const cachedBranch =
    typeof cache?.branchAt === "number" && now0 - cache.branchAt < STALE_AFTER_MS
      ? cache.branch
      : null;
  let fellBack = false;
  const branch = resolveBranch(cc, cachedBranch ?? null, () => {
    fellBack = true;
  });
  const result = await pending;
  const now = Date.now();
  const identity = chooseIdentity(result, cache, now);

  // Rewrite only on a change, or to refresh metaAt well inside the stale
  // window, so a steady fleet doesn't write a file per agent per tick.
  const next = { ...cache };
  if (identity.kind === "fresh") {
    next.meta = identity.meta;
    next.metaAt = now;
  }
  const branchRead = Boolean(branch) && !fellBack;
  if (branchRead) {
    next.branch = branch;
    next.branchAt = now;
  }
  const refreshDue = (at) => {
    const age = now - (at ?? 0);
    return age > CACHE_REFRESH_MS || age < 0; // < 0: the clock jumped back
  };
  const changed =
    JSON.stringify(next.meta) !== JSON.stringify(cache?.meta) ||
    next.branch !== cache?.branch ||
    (identity.kind === "fresh" && refreshDue(cache?.metaAt)) ||
    (branchRead && refreshDue(cache?.branchAt));
  if (changed) writeCache(path, next);

  const meta = identity.kind === "offline" ? null : identity.meta;
  if (identity.kind === "offline") {
    // Server definitively gone, or no good answer for OFFLINE_AFTER_MS —
    // distinguishable from "outside autonomOS".
    console.log("[autonomos · offline]");
  } else {
    console.log(formatHierarchy(meta, { stale: identity.kind === "cached" && identity.stale }));
  }
  console.log(formatActivity(cc, meta, branch));
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
  chooseIdentity,
  fetchSelf,
  formatActivity,
  formatDuration,
  formatHierarchy,
  getSelfMeta,
  readGitBranch,
  resolveBranch,
  STALE_AFTER_MS,
  OFFLINE_AFTER_MS,
};
