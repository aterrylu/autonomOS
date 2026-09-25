/**
 * Per-agent analytics for the Org Chart inspector.
 *
 * Everything here is COUNTED from signals the server already sees at existing
 * chokepoints — nothing is estimated:
 *  - status transitions: `emitStatusDelta` (hooks.ts), the one function every
 *    activity-state change (hook relay, Codex daemon feed, compaction) passes
 *    through → time in state, turns, waits on a human, a 24h activity strip;
 *  - tool calls: the hook relay's PreToolUse / PostToolUseFailure;
 *  - lifecycle: markRunning (starts → restarts), markExited (crashes), and the
 *    PTY exit (last exit code).
 *
 * In memory only, so every number is "since the server started" — the response
 * says so (`since`) and the UI labels it. Honesty per runtime: Codex reports no
 * per-tool events and no needs-input state, Gemini no tool failures; `support`
 * says which fields a runtime can fill so the UI shows "n/a" instead of a zero
 * that looks like a measurement.
 */

import { execFile } from "node:child_process";
import type { AgentAnalytics } from "@autonomos/core";
import { gitEnv } from "../sourceUpgrade.js";

const SERVER_STARTED_AT = Date.now();
const DAY_MS = 86_400_000;
/** Transitions kept per agent for the activity strip (pruned to 24h too). */
const MAX_TRANSITIONS = 600;
const TOP_TOOLS = 5;
/** Tool names kept per agent — a runaway set of unique names can't grow memory. */
const MAX_TOOL_NAMES = 64;

const WORKING = new Set([
  "working",
  "tool_running",
  "orchestrating",
  "compacting",
]);

interface Stats {
  status: { current: string; since: number } | null;
  transitions: Array<{ at: number; status: string }>;
  turns: number;
  waits: { count: number; totalMs: number; waitingSince: number | null };
  tools: Map<string, number>;
  toolCalls: number;
  failedTools: number;
  lastTool: { name: string; at: number } | null;
  starts: number;
  crashes: number;
  lastExitCode: number | null;
}

const stats = new Map<string, Stats>();

function get(id: string): Stats {
  let s = stats.get(id);
  if (!s) {
    s = {
      status: null,
      transitions: [],
      turns: 0,
      waits: { count: 0, totalMs: 0, waitingSince: null },
      tools: new Map(),
      toolCalls: 0,
      failedTools: 0,
      lastTool: null,
      starts: 0,
      crashes: 0,
      lastExitCode: null,
    };
    stats.set(id, s);
  }
  return s;
}

/** Record an activity-status change (called for every status delta; a repeat
 *  of the current status is ignored, so unread-only deltas cost nothing). */
export function observeStatus(
  id: string,
  status: string,
  now = Date.now(),
): void {
  const s = get(id);
  const prev = s.status?.current;
  if (prev === status) return;
  // A finished turn: from working-ish to at-rest (Stop → idle; Codex's daemon
  // reports active → idle the same way).
  if (prev && WORKING.has(prev) && (status === "idle" || status === "ready")) {
    s.turns += 1;
  }
  if (status === "needs_input" && prev !== "needs_input") {
    s.waits.count += 1;
    s.waits.waitingSince = now;
  } else if (prev === "needs_input" && s.waits.waitingSince !== null) {
    s.waits.totalMs += Math.max(0, now - s.waits.waitingSince);
    s.waits.waitingSince = null;
  }
  s.status = { current: status, since: now };
  s.transitions.push({ at: now, status });
  const cutoff = now - DAY_MS;
  while (
    s.transitions.length > MAX_TRANSITIONS ||
    (s.transitions.length > 1 && s.transitions[1].at < cutoff)
  ) {
    s.transitions.shift();
  }
}

/** Record a tool call (PreToolUse) or a failed one (PostToolUseFailure). */
export function observeTool(
  id: string,
  kind: "call" | "failure",
  name: string | undefined,
  now = Date.now(),
): void {
  const s = get(id);
  if (kind === "failure") {
    s.failedTools += 1;
    return;
  }
  if (!name) return;
  s.toolCalls += 1;
  s.lastTool = { name, at: now };
  if (s.tools.has(name) || s.tools.size < MAX_TOOL_NAMES) {
    s.tools.set(name, (s.tools.get(name) ?? 0) + 1);
  }
}

/** Lifecycle: a (re)start, an exit reason, or the PTY's exit code. */
export function observeStart(id: string): void {
  get(id).starts += 1;
}
/** An exit closes the agent's state: a kill or crash sends no SessionEnd, so
 *  without this an open wait would keep growing ("waiting now" on a dead
 *  agent), the strip would keep painting "working", and a resume's first
 *  ready/idle would count as a phantom turn. */
export function observeExit(
  id: string,
  reason: string,
  now = Date.now(),
): void {
  if (reason === "crashed") get(id).crashes += 1;
  observeStatus(id, "stopped", now);
}
export function observeExitCode(id: string, code: number | null): void {
  get(id).lastExitCode = code;
}

export function forgetAgentAnalytics(id: string): void {
  stats.delete(id);
  branchCache.delete(id);
}

/** Which fields a runtime can actually report (the rest render "n/a"). */
export function supportFor(
  provider: string | undefined,
): AgentAnalytics["support"] {
  if (provider === "codex")
    return { tools: false, needsInput: false, failedTools: false };
  if (provider === "gemini-cli")
    return { tools: true, needsInput: true, failedTools: false };
  return { tools: true, needsInput: true, failedTools: true };
}

// ── Git branch (async, cached; never blocks the event loop) ─────────

const BRANCH_TTL_MS = 30_000;
const branchCache = new Map<string, { at: number; branch: string | null }>();

function readBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "branch", "--show-current"],
      // Scrubbed env: an inherited GIT_DIR (the server started from a hook or
      // a git alias) would otherwise answer for the OUTER repo, not `cwd`.
      { timeout: 2000, encoding: "utf8", env: gitEnv() },
      (err, stdout) => {
        const b = err ? "" : String(stdout).trim();
        resolve(b || null);
      },
    );
  });
}

async function branchFor(
  id: string,
  cwd: string | undefined,
): Promise<string | null> {
  if (!cwd) return null;
  const hit = branchCache.get(id);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.branch;
  const branch = await readBranch(cwd);
  branchCache.set(id, { at: Date.now(), branch });
  return branch;
}

/** One agent's analytics snapshot. */
export async function getAgentAnalytics(
  id: string,
  opts: { provider?: string; workingDirectory?: string; startedAt?: number },
  now = Date.now(),
): Promise<AgentAnalytics> {
  const s = stats.get(id);
  const cutoff = now - DAY_MS;
  // Activity strip: contiguous segments over the last 24h.
  const activity: AgentAnalytics["activity"] = [];
  const t = s?.transitions ?? [];
  for (let i = 0; i < t.length; i++) {
    const from = Math.max(t[i].at, cutoff);
    const to = i + 1 < t.length ? t[i + 1].at : now;
    if (!(to > cutoff && to > from)) continue;
    // A zero-length blip between two same-status runs (e.g. working for 0ms
    // between two tool calls) is dropped above; merge what it leaves behind so
    // the strip never shows two adjacent segments of the same status.
    const last = activity.at(-1);
    if (last && last.status === t[i].status && last.to === from) last.to = to;
    else activity.push({ from, to, status: t[i].status });
  }
  const waits = s?.waits ?? { count: 0, totalMs: 0, waitingSince: null };
  return {
    since: SERVER_STARTED_AT,
    startedAt: opts.startedAt ?? null,
    status: s?.status ?? null,
    turns: s?.turns ?? 0,
    waits: {
      count: waits.count,
      // Include an open wait so "waiting on you" grows live.
      totalMs:
        waits.totalMs +
        (waits.waitingSince !== null ? now - waits.waitingSince : 0),
      waitingSince: waits.waitingSince,
    },
    tools: [...(s?.tools ?? new Map<string, number>()).entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_TOOLS),
    toolCalls: s?.toolCalls ?? 0,
    failedTools: s?.failedTools ?? 0,
    lastTool: s?.lastTool ?? null,
    restarts: Math.max(0, (s?.starts ?? 0) - 1),
    crashes: s?.crashes ?? 0,
    lastExitCode: s?.lastExitCode ?? null,
    activity,
    branch: await branchFor(id, opts.workingDirectory),
    support: supportFor(opts.provider),
  };
}

/** For tests. */
export function _resetAnalyticsForTesting(): void {
  stats.clear();
  branchCache.clear();
}
