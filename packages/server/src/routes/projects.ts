import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";

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
}

export const projectRouter = new Hono();

/** GET /api/projects — all Claude Code sessions grouped by project */
projectRouter.get("/", async (c) => {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;

  const sessions = await listSessions();

  // Group sessions by cwd (project directory)
  const projectMap = new Map<string, ProjectSession[]>();

  for (const s of sessions) {
    const cwd = s.cwd || "unknown";
    if (!projectMap.has(cwd)) {
      projectMap.set(cwd, []);
    }
    projectMap.get(cwd)!.push({
      sessionId: s.sessionId,
      summary: s.summary,
      lastModified: s.lastModified,
      gitBranch: s.gitBranch,
      firstPrompt: s.firstPrompt,
    });
  }

  // Build project list sorted by most recently active
  const projects: ProjectInfo[] = [];
  for (const [path, projectSessions] of projectMap) {
    // Sort sessions within each project by recency
    projectSessions.sort((a, b) => b.lastModified - a.lastModified);

    // Derive project name from path (last directory component)
    const name = path === "unknown" ? "Unknown" : path.split("/").pop() || path;

    projects.push({
      path,
      name,
      sessions: projectSessions,
      lastActive: projectSessions[0].lastModified,
    });
  }

  // Sort projects by most recently active
  projects.sort((a, b) => b.lastActive - a.lastActive);

  return c.json(projects);
});
