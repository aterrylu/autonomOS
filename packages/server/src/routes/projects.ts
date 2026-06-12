import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
import { batchGetTitles } from "../titleCache";

const execFileAsync = promisify(execFile);

/**
 * Home-relative roots where macOS TCC guards file access. Spawning git with
 * cwd inside one of these makes the OS attribute the directory reads to the
 * responsible process (the desktop app / dev server) and fire a permission
 * prompt per root — users with old CC sessions under Desktop/Documents/iCloud
 * got a storm of prompts at first launch just to render a sidebar badge.
 * We skip the diff-stat exec entirely for these; the badge silently stays
 * absent for projects living in protected folders.
 */
export const TCC_PROTECTED_ROOTS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library/Mobile Documents",
  "Pictures",
  "Music",
  "Movies",
] as const;

/**
 * True when cwd is the home directory itself or sits inside a TCC-protected
 * root. Comparison is path-boundary aware (~/DocumentsFoo is NOT protected)
 * and case-folded — macOS APFS is case-insensitive, so ~/documents/x reaches
 * the same protected dir and must match the deny-list too.
 */
export function isTccProtectedPath(cwd: string, home = homedir()): boolean {
  const target = resolve(cwd).toLowerCase();
  const homePath = resolve(home).toLowerCase();
  // git walks parent dirs from ~ looking for .git — exactly the bad case
  if (target === homePath) return true;
  return TCC_PROTECTED_ROOTS.some((root) => {
    const rootPath = join(homePath, root.toLowerCase());
    return target === rootPath || target.startsWith(rootPath + sep);
  });
}

export interface GitDiffStat {
  insertions: number;
  deletions: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
  sessions: ProjectSession[];
  lastActive: number;
}

export interface ProjectSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
  firstPrompt?: string;
  /** User-set title via /rename — SDK bug: currently returns undefined (v0.2.71) */
  customTitle?: string;
  gitDiffStat?: GitDiffStat;
  /** True if this session is managed by autonomOS (has an agent record) */
  isAutonomosAgent?: boolean;
  /** Lifecycle status for autonomOS agents: "running" or "exited" */
  autonomosStatus?: "running" | "exited";
  /** Template used to spawn this agent */
  template?: string;
  /** Manager display name in the org chart (resolved from managerId) */
  manager?: string;
  /** Project scope */
  project?: string;
}

export const projectRouter = new Hono();

/** GET /api/projects — all Claude Code sessions grouped by project */
projectRouter.get("/", async (c) => {
  let sessions: SDKSessionInfo[];
  try {
    sessions = await deps.listSessions();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to list projects:", message);
    return c.json(
      { error: "Failed to list Claude Code sessions", detail: message },
      500,
    );
  }

  const needsTitleLookup = sessions
    .filter((s) => !s.customTitle && s.cwd)
    .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd! }));

  const resolvedTitles =
    needsTitleLookup.length > 0
      ? await batchGetTitles(needsTitleLookup)
      : new Map<string, string>();

  // Group sessions by project directory
  const projectMap = new Map<string, ProjectSession[]>();
  for (const s of sessions) {
    const cwd = s.cwd || "unknown";
    const title = s.customTitle || resolvedTitles.get(s.sessionId);
    if (!projectMap.has(cwd)) projectMap.set(cwd, []);
    projectMap.get(cwd)!.push({
      sessionId: s.sessionId,
      summary: title || s.summary,
      lastModified: s.lastModified,
      gitBranch: s.gitBranch,
      firstPrompt: s.firstPrompt,
      customTitle: title,
    });
  }

  const projects: ProjectInfo[] = Array.from(
    projectMap,
    ([path, projectSessions]) => {
      projectSessions.sort((a, b) => b.lastModified - a.lastModified);
      return {
        path,
        name: path === "unknown" ? "Unknown" : basename(path) || path,
        sessions: projectSessions,
        lastActive: projectSessions[0].lastModified,
      };
    },
  );

  // Cross-reference with autonomOS agent records to enrich metadata.
  // Agent.id === providerSessionId for migrated agents; for fresh agents the
  // providerSessionId is the canonical CC sessionId, so we key off that.
  const agents = listAgents();
  const byProviderSessionId = new Map(
    agents.map((a) => [a.providerSessionId, a]),
  );
  for (const p of projects) {
    for (const s of p.sessions) {
      const entry = byProviderSessionId.get(s.sessionId);
      if (entry) {
        s.isAutonomosAgent = true;
        s.autonomosStatus = entry.status;
        s.template = entry.template;
        s.manager = entry.managerId
          ? (getAgent(entry.managerId)?.name ?? undefined)
          : undefined;
        s.project = entry.project;
      }
    }
  }

  const allSessions = projects.flatMap((p) =>
    p.sessions.map((s) => ({ session: s, cwd: p.path })),
  );
  await Promise.all(
    allSessions.map(async ({ session, cwd }) => {
      if (cwd === "unknown" || !session.gitBranch) return;
      // a failed badge lookup must never take down the whole listing
      session.gitDiffStat = await getGitDiffStat(cwd, session.gitBranch).catch(
        () => undefined,
      );
    }),
  );

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return c.json(projects);
});

/** TTL for cached diff stats — the sidebar polls every 30s; re-execing git
 * for every project on every poll is wasteful. */
const DIFF_STAT_TTL_MS = 90_000;

const diffStatCache = new Map<
  string,
  { at: number; stat: GitDiffStat | undefined }
>();

const defaultDeps = {
  execFileAsync: execFileAsync as (
    file: string,
    args: string[],
    options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>,
  existsSync,
  homedir,
  listSessions,
  now: () => Date.now(),
  platform: () => process.platform,
};

let deps = { ...defaultDeps };

/** Replace semantics: unlisted deps revert to their real defaults. */
export function _setDepsForTesting(
  overrides: Partial<typeof defaultDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetForTesting(): void {
  deps = { ...defaultDeps };
  diffStatCache.clear();
  gitMissingWarned = false;
}

/** Warn once, not per-repo-per-poll, when git isn't on PATH (e.g. a
 * launchd-spawned bundled server with a stripped environment). */
let gitMissingWarned = false;

async function getGitDiffStat(
  cwd: string,
  branch: string,
): Promise<GitDiffStat | undefined> {
  // Never spawn git inside TCC-protected dirs — see TCC_PROTECTED_ROOTS.
  // TCC is a macOS facility; on other platforms ~/Documents is an ordinary
  // repo location and the badge should keep working.
  if (deps.platform() === "darwin" && isTccProtectedPath(cwd, deps.homedir()))
    return undefined;
  // Only exec in actual repo roots; also stops git's upward .git walk.
  // Tradeoff: sessions launched in a repo SUBdirectory lose the badge.
  if (!deps.existsSync(join(cwd, ".git"))) return undefined;

  const key = `${cwd}\0${branch}`;
  const cached = diffStatCache.get(key);
  if (cached && deps.now() - cached.at < DIFF_STAT_TTL_MS) return cached.stat;

  let stat: GitDiffStat | undefined;
  try {
    const { stdout } = await deps.execFileAsync(
      "git",
      ["diff", "main...HEAD", "--shortstat"],
      // LC_ALL=C: --shortstat output is gettext-localized; the regexes
      // below only match the English wording
      { cwd, timeout: 5000, env: { ...process.env, LC_ALL: "C" } },
    );
    const ins = stdout.match(/(\d+) insertion/);
    const del = stdout.match(/(\d+) deletion/);
    const insertions = ins ? Number.parseInt(ins[1], 10) : 0;
    const deletions = del ? Number.parseInt(del[1], 10) : 0;
    if (insertions > 0 || deletions > 0) stat = { insertions, deletions };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    if (e.code === "ENOENT") {
      // git binary missing — a configuration error, not a per-repo result
      if (!gitMissingWarned) {
        gitMissingWarned = true;
        console.warn("git not found on PATH; sidebar diff badges disabled");
      }
      return undefined;
    }
    // Timeout (killed) or other spawn failure — transient; don't poison
    // the cache with a 90s "no diff" for a repo that may have one
    if (typeof e.code !== "number") return undefined;
    // git ran and exited non-zero (e.g. no `main` base ref) — a stable
    // negative, fall through and cache it
  }
  diffStatCache.set(key, { at: deps.now(), stat });
  return stat;
}
