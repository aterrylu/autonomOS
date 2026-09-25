import { basename } from "node:path";
import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProjectInfo, ProjectSession } from "@autonomos/core";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
import { batchGetTitles } from "../titleCache";

// Wire shapes live in @autonomos/core (types/api.ts) — one declaration
// shared with the dashboard client.
export type { ProjectInfo, ProjectSession } from "@autonomos/core";

export const projectRouter = new Hono();

/** GET /api/projects — all Claude Code sessions grouped by project */
projectRouter.get("/", async (c) => {
  let sessions: SDKSessionInfo[];
  try {
    sessions = await listSessionsFn();
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

  // Group sessions by project directory. A session with NO cwd gets its own
  // group keyed by sessionId (all displayed as "Unknown") so unrelated cwd-less
  // sessions don't merge into one pseudo-project.
  const projectMap = new Map<string, ProjectSession[]>();
  const push = (cwd: string, s: ProjectSession) => {
    if (!projectMap.has(cwd)) projectMap.set(cwd, []);
    projectMap.get(cwd)!.push(s);
  };
  for (const s of sessions) {
    const cwd = s.cwd || `unknown:${s.sessionId}`;
    // `summary` carries the resolved display title (SDK customTitle → JSONL
    // title cache → SDK summary). The old redundant `customTitle` wire field is
    // gone — it duplicated this and was misnamed for a resolved value.
    const title = s.customTitle || resolvedTitles.get(s.sessionId);
    push(cwd, {
      sessionId: s.sessionId,
      provider: "claude-code",
      summary: title || s.summary,
      lastModified: s.lastModified,
      gitBranch: s.gitBranch,
      firstPrompt: s.firstPrompt,
    });
  }

  // ── Codex discovery seam (owned by CodexGemini's PR) ────────────────────
  // Enumerates ~/.codex rollout JSONLs → rows in the SHARED ProjectSession shape
  // (provider:"codex", summary=derived title, no branch, originator class), each
  // paired with its cwd for grouping. No-op until that PR lands, so this listing
  // stays CC-only but already provider-shaped; the UI renders whatever appears.
  try {
    for (const { cwd, session } of await listCodexSessionsFn()) {
      push(cwd || `unknown:${session.sessionId}`, session);
    }
  } catch (err) {
    console.error(
      "listCodexSessions failed; Codex rows omitted this tick:",
      err instanceof Error ? err.message : err,
    );
  }

  const projects: ProjectInfo[] = Array.from(
    projectMap,
    ([path, projectSessions]) => {
      projectSessions.sort((a, b) => b.lastModified - a.lastModified);
      return {
        path,
        name: path.startsWith("unknown:") ? "Unknown" : basename(path) || path,
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
  return c.json(projects);
});

/** A Codex session row plus the cwd it groups under. CodexGemini's discovery PR
 *  implements the enumerator; the shared `ProjectSession` shape is what the UI
 *  renders (provider:"codex", summary=derived title, no gitBranch, originator). */
export interface CodexSessionRow {
  cwd: string;
  session: ProjectSession;
}

// Indirection so tests can stub session listing + title resolution without a
// real SDK or a populated ~/.claude/projects on disk.
let listSessionsFn: typeof listSessions = listSessions;
let batchGetTitlesFn: typeof batchGetTitles = batchGetTitles;
// Codex discovery seam — no-op until CodexGemini's rollout scanner lands.
let listCodexSessionsFn: () => Promise<CodexSessionRow[]> = async () => [];

export function _setDepsForTesting(overrides: {
  listSessions?: typeof listSessions;
  batchGetTitles?: typeof batchGetTitles;
  listCodexSessions?: () => Promise<CodexSessionRow[]>;
}): void {
  if (overrides.listSessions) listSessionsFn = overrides.listSessions;
  if (overrides.batchGetTitles) batchGetTitlesFn = overrides.batchGetTitles;
  if (overrides.listCodexSessions)
    listCodexSessionsFn = overrides.listCodexSessions;
}

export function _resetForTesting(): void {
  listSessionsFn = listSessions;
  batchGetTitlesFn = batchGetTitles;
  listCodexSessionsFn = async () => [];
}
