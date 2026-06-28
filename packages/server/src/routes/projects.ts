import { createRequire } from "node:module";
import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  listSessions,
  SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
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

// Response cache for GET /api/projects. The underlying computation
// (listSessions + per-session git diff) is O(seconds) when the user has
// thousands of Claude Code session files, and it runs partly synchronously,
// blocking the Node event loop — including the WebSocket pipeline that
// streams terminal echoes. The sidebar polls this every 30s; recomputing on
// every poll caused ~8s typing stalls on each cycle. Cache here so the
// response path is O(1); refresh in the background past the TTL so stale-
// but-not-blocking is the failure mode.
const PROJECTS_CACHE_TTL_MS = 60_000;
let projectsCache: ProjectInfo[] | null = null;
let projectsCacheAt = 0;
let projectsRefreshInFlight: Promise<ProjectInfo[]> | null = null;

/** Run listSessions() in a worker_thread so its ~10s of sync JSON parsing
 *  doesn't block the main event loop (and therefore the terminal WebSocket
 *  pipeline). The worker exits after responding. */
async function listSessionsInWorker(): Promise<SDKSessionInfo[]> {
  const workerUrl = new URL("./projects-worker.ts", import.meta.url);
  // Resolve tsx's loader to an ABSOLUTE path. Passing the bare specifier
  // "tsx" makes the worker resolve it from its cwd — under pm2 that's the repo
  // root, which has no node_modules/tsx (it lives in packages/server's tree),
  // so the worker died with "Cannot find package 'tsx'" on every call and the
  // project list silently never loaded. Resolving from import.meta.url anchors
  // the lookup to this file's package regardless of cwd.
  const tsxLoader = createRequire(import.meta.url).resolve("tsx");
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      // tsx must load TypeScript inside the worker too — without this the
      // worker fails on the .ts extension.
      execArgv: ["--import", tsxLoader],
    });
    const cleanup = () => {
      worker.terminate().catch(() => {});
    };
    worker.once(
      "message",
      (
        msg:
          | { ok: true; sessions: SDKSessionInfo[] }
          | { ok: false; error: string },
      ) => {
        cleanup();
        if (msg.ok) resolve(msg.sessions);
        else reject(new Error(msg.error));
      },
    );
    worker.once("error", (err) => {
      cleanup();
      reject(err);
    });
    worker.once("exit", (code) => {
      if (code !== 0)
        reject(new Error(`projects-worker exited with code ${code}`));
    });
    worker.postMessage("run");
  });
}

async function computeProjects(): Promise<ProjectInfo[]> {
  const sessions = await listSessionsFn();

  const needsTitleLookup = sessions
    .filter((s) => !s.customTitle && s.cwd)
    .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd! }));

  let resolvedTitles = new Map<string, string>();
  if (needsTitleLookup.length > 0) {
    try {
      resolvedTitles = await batchGetTitlesFn(needsTitleLookup);
    } catch (err) {
      // Title resolution is best-effort enrichment; a failure (e.g. HOME unset
      // on a launchd-spawned server) must not take down the whole listing.
      // Sessions fall back to their SDK summary below.
      console.error(
        "batchGetTitles failed; falling back to SDK summaries:",
        err instanceof Error ? err.message : err,
      );
    }
  }

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

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return projects;
}

function refreshProjectsCache(): Promise<ProjectInfo[]> {
  if (projectsRefreshInFlight) return projectsRefreshInFlight;
  projectsRefreshInFlight = computeProjects()
    .then((result) => {
      projectsCache = result;
      projectsCacheAt = Date.now();
      return result;
    })
    .finally(() => {
      projectsRefreshInFlight = null;
    });
  return projectsRefreshInFlight;
}

/** GET /api/projects — all Claude Code sessions grouped by project */
projectRouter.get("/", async (c) => {
  const age = Date.now() - projectsCacheAt;

  // Fresh cache hit — return immediately, no refresh.
  if (projectsCache && age < PROJECTS_CACHE_TTL_MS) {
    return c.json(projectsCache);
  }

  // Stale cache — return what we have AND kick off a background refresh.
  // The errors are caught so a failed refresh doesn't reject this request;
  // the next call will retry.
  if (projectsCache) {
    refreshProjectsCache().catch((err) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Background projects refresh failed:", message);
    });
    return c.json(projectsCache);
  }

  // Cold start — no cache yet, must await the first computation.
  try {
    const result = await refreshProjectsCache();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to list projects:", message);
    return c.json(
      { error: "Failed to list Claude Code sessions", detail: message },
      500,
    );
  }
});

// Indirection so tests can stub session listing + title resolution without a
// real SDK or a populated ~/.claude/projects on disk. Production defaults to the
// worker-thread listing (keeps the ~4s sync scan off the main event loop);
// tests override it with an in-memory fake via _setDepsForTesting.
let listSessionsFn: typeof listSessions = listSessionsInWorker;
let batchGetTitlesFn: typeof batchGetTitles = batchGetTitles;

export function _setDepsForTesting(overrides: {
  listSessions?: typeof listSessions;
  batchGetTitles?: typeof batchGetTitles;
}): void {
  if (overrides.listSessions) listSessionsFn = overrides.listSessions;
  if (overrides.batchGetTitles) batchGetTitlesFn = overrides.batchGetTitles;
}

export function _resetForTesting(): void {
  listSessionsFn = listSessionsInWorker;
  batchGetTitlesFn = batchGetTitles;
  // Clear the module-scope response cache so each test starts from a cold
  // state and sees its own stubbed sessions rather than a prior test's result.
  projectsCache = null;
  projectsCacheAt = 0;
  projectsRefreshInFlight = null;
}
