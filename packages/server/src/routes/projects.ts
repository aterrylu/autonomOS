import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { batchGetTitles } from "../titleCache";

const execFileAsync = promisify(execFile);

export interface GitDiffStat {
  insertions: number;
  deletions: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
  sessions: ProjectSession[];
  lastActive: number;
  gitDiffStat?: GitDiffStat;
}

export interface ProjectSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
  firstPrompt?: string;
  /** User-set title via /rename — SDK bug: currently returns undefined (v0.2.71) */
  customTitle?: string;
}

export const projectRouter = new Hono();

/** GET /api/projects — all Claude Code sessions grouped by project */
projectRouter.get("/", async (c) => {
  let sessions: SDKSessionInfo[];
  try {
    sessions = await listSessions();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to list projects:", message);
    return c.json(
      { error: "Failed to list Claude Code sessions", detail: message },
      500,
    );
  }

  // Batch-resolve custom titles for sessions where SDK returns none.
  // This reads the actual JSONL files (with mtime caching) to work around
  // the SDK's 64KB head/tail buffer limitation.
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

  // Build project list, each with sessions sorted by recency
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

  // Fetch git diff stats in parallel for all projects
  await Promise.all(
    projects.map(async (p) => {
      if (p.path === "unknown") return;
      p.gitDiffStat = await getGitDiffStat(p.path);
    }),
  );

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return c.json(projects);
});

async function getGitDiffStat(cwd: string): Promise<GitDiffStat | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--shortstat"],
      {
        cwd,
        timeout: 5000,
      },
    );
    // Output: " 3 files changed, 101 insertions(+), 5 deletions(-)"
    const ins = stdout.match(/(\d+) insertion/);
    const del = stdout.match(/(\d+) deletion/);
    const insertions = ins ? Number.parseInt(ins[1], 10) : 0;
    const deletions = del ? Number.parseInt(del[1], 10) : 0;
    if (insertions === 0 && deletions === 0) return undefined;
    return { insertions, deletions };
  } catch {
    return undefined;
  }
}
