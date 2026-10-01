import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import {
  listSessions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProjectInfo, ProjectKind, ProjectSession } from "@autonomos/core";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
import { resolveDir } from "../projectResolver.js";
import { claudeProjectsDir } from "../providers/claude-code.js";
import {
  type ClaudeSessionMeta,
  listCodexSessions,
  listGeminiSessions,
  NO_PROMPT_YET,
  readClaudeSessionMeta,
} from "../sessionScanners.js";
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
  // Claude Code sessions' own cwd + entrypoint, from each JSONL's head: the
  // SDK listing misses the cwd of a session that opens with queue-operation
  // records (every "Unknown" project was one), and never reports headless.
  const claudeMetaP = readClaudeSessionMetaFn().catch((err: unknown) => {
    console.error(
      "readClaudeSessionMeta failed; Claude Code rows lack cwd/headless this tick:",
      err instanceof Error ? err.message : err,
    );
    return new Map<string, ClaudeSessionMeta>();
  });
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

  // Group sessions by PROJECT: a git repo (worktrees fold into their main
  // repo), else the directory, with throwaway temp dirs flagged (the UI folds
  // them into "Other"). projectResolver never blocks — git runs off the
  // request path and fills in on a later poll.
  const projectMap = new Map<string, ProjectSession[]>();
  const kindOf = new Map<string, ProjectKind>();
  const resolvedByOf = new Map<string, ProjectInfo["repoResolvedBy"]>();
  // Non-repo dirs: ONE project per real directory. The runtimes disagree on
  // spelling — Codex, Gemini and sometimes Claude Code record the REALPATH
  // (/private/tmp/x on macOS), agent records the path as typed (/tmp/x). The
  // first spelling seen becomes the key; Claude Code rows are pushed first.
  const keyByReal = new Map<string, string>();
  const realOf = new Map<string, string>();
  const keyFor = (cwd: string): string => {
    let real = realOf.get(cwd);
    if (real === undefined) {
      try {
        real = realpathSync(cwd);
      } catch {
        real = cwd;
      }
      realOf.set(cwd, real);
    }
    const known = keyByReal.get(real);
    if (known) return known;
    keyByReal.set(real, cwd);
    return cwd;
  };
  const existsMemo = new Map<string, boolean>();
  const exists = (dir: string): boolean => {
    let e = existsMemo.get(dir);
    if (e === undefined) {
      e = existsSync(dir);
      existsMemo.set(dir, e);
    }
    return e;
  };
  const push = (cwd: string | undefined, s: ProjectSession) => {
    let key: string;
    let kind: ProjectKind;
    if (!cwd) {
      // No runtime recorded a directory: throwaway, never an "Unknown" group.
      key = `unknown:${s.sessionId}`;
      kind = "temp";
    } else {
      s.cwd = cwd;
      s.cwdExists = exists(cwd);
      const res = resolveDir(cwd, s.cwdExists);
      kind = res.kind;
      key = res.repoRoot ?? keyFor(cwd);
      if (res.resolvedBy) {
        // The strongest evidence any session gave wins for the group.
        const rank = { git: 3, learned: 2, convention: 1 } as const;
        const prev = resolvedByOf.get(key);
        if (!prev || rank[res.resolvedBy] > rank[prev])
          resolvedByOf.set(key, res.resolvedBy);
      }
    }
    // A group is a repo if any of its sessions resolved to one.
    const prevKind = kindOf.get(key);
    if (!prevKind || kind === "repo") kindOf.set(key, kind);
    if (!projectMap.has(key)) projectMap.set(key, []);
    projectMap.get(key)!.push(s);
  };
  const claudeMeta = await claudeMetaP;
  for (const s of sessions) {
    const meta = claudeMeta.get(s.sessionId);
    const cwd = s.cwd || meta?.cwd;
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
      // Only SDK runs (`sdk-py`, `sdk-ts`, `sdk-cli`, …) are headless. Other
      // interactive entrypoints (the IDE extension, the desktop app) are not.
      headless: meta?.entrypoint?.startsWith("sdk-") === true,
      ...(meta?.entrypoint?.startsWith("sdk-")
        ? { startedVia: meta.entrypoint }
        : {}),
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
      push(managed?.workingDirectory || cwd || undefined, row);
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
    push(a.workingDirectory || undefined, {
      sessionId: a.providerSessionId,
      provider: a.provider,
      summary: a.name,
      lastModified: a.exitedAt ?? a.updatedAt ?? a.createdAt ?? 0,
      headless: false,
    });
  }

  const projects: ProjectInfo[] = Array.from(
    projectMap,
    ([path, projectSessions]) => {
      projectSessions.sort((a, b) => b.lastModified - a.lastModified);
      const counts = { visible: 0, headless: 0, removed: 0 };
      for (const s of projectSessions) {
        if (s.headless) counts.headless++;
        else if (s.cwdExists === false) counts.removed++;
        else counts.visible++;
      }
      return {
        path,
        name: path.startsWith("unknown:")
          ? "(no directory)"
          : basename(path) || path,
        kind: kindOf.get(path) ?? "dir",
        repoResolvedBy: resolvedByOf.get(path),
        sessions: projectSessions,
        lastActive: projectSessions[0].lastModified,
        counts,
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
        // A managed session with no prompt yet reads as its agent's name —
        // what the person knows it by — not as a placeholder.
        if (s.summary === NO_PROMPT_YET) s.summary = entry.name;
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
let readClaudeSessionMetaFn: () => Promise<Map<string, ClaudeSessionMeta>> =
  () => readClaudeSessionMeta(claudeProjectsDir(process.cwd()));
let listGeminiSessionsFn: () => Promise<CodexSessionRow[]> = () =>
  listGeminiSessions();

export function _setDepsForTesting(overrides: {
  listSessions?: typeof listSessions;
  batchGetTitles?: typeof batchGetTitles;
  listCodexSessions?: () => Promise<CodexSessionRow[]>;
  listGeminiSessions?: () => Promise<CodexSessionRow[]>;
  readClaudeSessionMeta?: () => Promise<Map<string, ClaudeSessionMeta>>;
}): void {
  if (overrides.listSessions) listSessionsFn = overrides.listSessions;
  if (overrides.batchGetTitles) batchGetTitlesFn = overrides.batchGetTitles;
  if (overrides.listCodexSessions)
    listCodexSessionsFn = overrides.listCodexSessions;
  if (overrides.listGeminiSessions)
    listGeminiSessionsFn = overrides.listGeminiSessions;
  if (overrides.readClaudeSessionMeta)
    readClaudeSessionMetaFn = overrides.readClaudeSessionMeta;
}

export function _resetForTesting(): void {
  listSessionsFn = listSessions;
  batchGetTitlesFn = batchGetTitles;
  listCodexSessionsFn = () => listCodexSessions();
  listGeminiSessionsFn = () => listGeminiSessions();
  readClaudeSessionMetaFn = () =>
    readClaudeSessionMeta(claudeProjectsDir(process.cwd()));
}
