import { realpathSync } from "node:fs";
import { basename } from "node:path";
import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProjectInfo, ProjectSession } from "@autonomos/core";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
import { listCodexSessions, listGeminiSessions } from "../sessionScanners.js";
import { batchGetTitles } from "../titleCache";

// Wire shapes live in @autonomos/core (types/api.ts) — one declaration
// shared with the dashboard client.
export type { ProjectInfo, ProjectSession } from "@autonomos/core";

export const projectRouter = new Hono();

/** GET /api/projects — Claude Code, Codex and Gemini sessions (plus every
 *  managed agent) grouped by project directory. */
projectRouter.get("/", async (c) => {
  // The three listings are independent — start the Codex/Gemini scans now so
  // they overlap the Claude Code listing instead of queuing behind it. Each
  // settles to rows or to its error; one failing costs only its own rows.
  const settle = (f: () => Promise<CodexSessionRow[]>) =>
    f().then(
      (rows) => ({ rows }),
      (err: unknown) => ({ rows: [] as CodexSessionRow[], err }),
    );
  const scans = [
    ["Codex", settle(listCodexSessionsFn)],
    ["Gemini", settle(listGeminiSessionsFn)],
  ] as const;
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

  // ── Codex + Gemini sessions, read from each CLI's own storage ──────────
  // (sessionScanners.ts: bounded, mtime-cached, malformed files skipped). A
  // failing scanner costs only its own rows, never the listing.
  const agents = listAgents();
  // A managed agent's conversation id in its runtime's own storage: Codex keys
  // by THREAD, Gemini (like Claude Code) by providerSessionId.
  const agentByRuntimeId = new Map<string, (typeof agents)[number]>();
  for (const a of agents) {
    if (a.provider === "codex") {
      if (a.providerThreadId) agentByRuntimeId.set(a.providerThreadId, a);
    } else if (a.providerSessionId) {
      agentByRuntimeId.set(a.providerSessionId, a);
    }
  }
  // Codex and Gemini record a session's cwd as its REALPATH (/private/tmp/x on
  // macOS), while Claude Code rows and agent records keep the path as typed
  // (/tmp/x). Map a scanned cwd back to the raw path already known for it, so
  // one directory is one project — never rewriting Claude Code's own paths.
  const rawFor = new Map<string, string>();
  const learn = (raw: string | undefined) => {
    if (!raw || raw.startsWith("unknown:")) return;
    try {
      const real = realpathSync(raw);
      if (real !== raw && !rawFor.has(real)) rawFor.set(real, raw);
    } catch {
      // gone or unresolvable: nothing to alias
    }
  };
  for (const key of projectMap.keys()) learn(key);
  for (const a of agents) learn(a.workingDirectory);

  for (const [label, scan] of scans) {
    const { rows, err } = (await scan) as {
      rows: CodexSessionRow[];
      err?: unknown;
    };
    if (err) {
      console.error(
        `list${label}Sessions failed; ${label} rows omitted this tick:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    for (const { cwd, session } of rows) {
      const managed = agentByRuntimeId.get(session.sessionId);
      // A managed agent's row carries the AGENT's providerSessionId — the id
      // the dashboard's Resume (POST /attach) resolves; a Codex thread id
      // would 404 there. Grouped under the agent's own working directory.
      // Never mutate what the scanner handed us (it may be a cache entry —
      // mutating it made every later poll miss this match): copy.
      // (Always a copy: the enrichment below writes onto rows, too.)
      const row = managed
        ? { ...session, sessionId: managed.providerSessionId }
        : { ...session };
      const dir =
        managed?.workingDirectory || (cwd && (rawFor.get(cwd) ?? cwd));
      push(dir || `unknown:${row.sessionId}`, row);
    }
  }

  // Managed agents with NO discoverable session still get a row — e.g. a
  // Codex agent killed before its first turn (codex saves a thread lazily) or a
  // Gemini agent from before sessions were named — so an exited agent of ANY
  // runtime shows under its directory and can be resumed from here. Claude
  // Code agents keep their SDK-listed rows; this only fills the gaps.
  const listed = new Set<string>();
  for (const list of projectMap.values())
    for (const s of list) listed.add(s.sessionId);
  for (const a of agents) {
    if (!a.providerSessionId || listed.has(a.providerSessionId)) continue;
    if (a.id !== a.providerSessionId && listed.has(a.id)) continue;
    push(a.workingDirectory || `unknown:${a.id}`, {
      sessionId: a.providerSessionId,
      provider: a.provider,
      summary: a.name,
      lastModified: a.exitedAt ?? a.updatedAt ?? a.createdAt ?? 0,
    });
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

/** A Codex/Gemini session row plus the cwd it groups under (sessionScanners.ts);
 *  the shared `ProjectSession` shape is what the UI renders. */
export interface CodexSessionRow {
  cwd: string;
  session: ProjectSession;
}

// Indirection so tests can stub session listing + title resolution without a
// real SDK or a populated ~/.claude/projects on disk.
let listSessionsFn: typeof listSessions = listSessions;
let batchGetTitlesFn: typeof batchGetTitles = batchGetTitles;
let listCodexSessionsFn: () => Promise<CodexSessionRow[]> = () =>
  listCodexSessions();
let listGeminiSessionsFn: () => Promise<CodexSessionRow[]> = () =>
  listGeminiSessions();

export function _setDepsForTesting(overrides: {
  listSessions?: typeof listSessions;
  batchGetTitles?: typeof batchGetTitles;
  listCodexSessions?: () => Promise<CodexSessionRow[]>;
  listGeminiSessions?: () => Promise<CodexSessionRow[]>;
}): void {
  if (overrides.listSessions) listSessionsFn = overrides.listSessions;
  if (overrides.batchGetTitles) batchGetTitlesFn = overrides.batchGetTitles;
  if (overrides.listCodexSessions)
    listCodexSessionsFn = overrides.listCodexSessions;
  if (overrides.listGeminiSessions)
    listGeminiSessionsFn = overrides.listGeminiSessions;
}

export function _resetForTesting(): void {
  listSessionsFn = listSessions;
  batchGetTitlesFn = batchGetTitles;
  listCodexSessionsFn = () => listCodexSessions();
  listGeminiSessionsFn = () => listGeminiSessions();
}
