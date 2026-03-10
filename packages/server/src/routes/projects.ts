import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { batchGetTitles } from "../titleCache";

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
        name: path === "unknown" ? "Unknown" : path.split("/").pop() || path,
        sessions: projectSessions,
        lastActive: projectSessions[0].lastModified,
      };
    },
  );

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return c.json(projects);
});
