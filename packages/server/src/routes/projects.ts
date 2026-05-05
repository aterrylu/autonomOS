import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
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
    sessions = await listSessions();
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
      session.gitDiffStat = await getGitDiffStat(cwd, session.gitBranch);
    }),
  );

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return c.json(projects);
});

async function getGitDiffStat(
  cwd: string,
  _branch: string,
): Promise<GitDiffStat | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "main...HEAD", "--shortstat"],
      { cwd, timeout: 5000 },
    );
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
