/**
 * Hierarchical memory event recording + level-routed query.
 *
 * Capture API:  recordEvent({ type, summary, ... }) → MemoryEvent | null
 * Read API:     queryMemory({ level, ... }) → MemoryQueryResponse
 *
 * recordEvent never throws — memory failures must not break the platform.
 * On any I/O error it logs to console.error and returns null. Callers can
 * fire-and-forget. (We keep writes synchronous because JSONL appends are
 * sub-ms at our volume, and async fire-and-forget loses crash-recoverability.)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  MemoryActor,
  MemoryEvent,
  MemoryEventType,
  MemoryLevel,
  MemoryQuery,
  MemoryQueryResponse,
  MemoryRefs,
} from "@autonomos/core";
import { MEMORY_SCHEMA_VERSION } from "@autonomos/core";
import { getAgent } from "../agents/store.js";
import { SCHEMA_DOC } from "./schema-doc.js";
import {
  ensureMemoryDirs,
  getDailyPath,
  getEventsDir,
  getEventsFile,
  getIndexPath,
  getProjectDir,
  getProjectSummaryPath,
  getProjectTimelinePath,
  getSchemaDocPath,
  makeEventId,
  normalizeProjectSlug,
  truncateSummary,
} from "./store.js";

// ── Recording ─────────────────────────────────────────────────────

export interface RecordEventInput {
  type: MemoryEventType;
  summary: string;
  /** Explicit actor — fields default to system if omitted. */
  actor?: Partial<MemoryActor>;
  /** Convenience: derive actor (name + sessionId) by looking up this agent id. */
  actorAgentId?: string | null;
  /** Project tag. `undefined` → inherit from actor agent's project field
   *  (or null if no actor agent). `null` → explicit untagged. String → normalized. */
  project?: string | null;
  payload?: Record<string, unknown>;
  refs?: MemoryRefs;
  /** Override timestamp (mainly for tests). */
  ts?: number;
}

/** Sentinel actor when no agent context is available (e.g. scheduler firing
 *  with no originating agent, or cleanup on agent removal). */
const SYSTEM_ACTOR: MemoryActor = {
  agentId: null,
  agentName: "system",
  sessionId: null,
};

/** Track project stats in-memory so L0 refresh doesn't require rescanning
 *  events on every write. Bootstrapped lazily on first call (or via
 *  bootstrapMemoryFromDisk on server startup). */
interface ProjectStats {
  count: number;
  latestTs: number;
}
const projectStats = new Map<string, ProjectStats>(); // key: slug, "_untagged_" for null
let statsBootstrapped = false;

const UNTAGGED_KEY = "_untagged_";

function statsKey(project: string | null): string {
  return project ?? UNTAGGED_KEY;
}

function buildActor(input: RecordEventInput): MemoryActor {
  // Explicit actor wins
  if (input.actor) {
    return {
      agentId: input.actor.agentId ?? null,
      agentName: input.actor.agentName ?? "system",
      sessionId: input.actor.sessionId ?? null,
    };
  }
  if (input.actorAgentId) {
    const agent = getAgent(input.actorAgentId);
    if (agent) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        sessionId: agent.providerSessionId,
      };
    }
    // Agent id given but not found — keep the id so payload still references it
    return {
      agentId: input.actorAgentId,
      agentName: `unknown(${input.actorAgentId.slice(0, 8)})`,
      sessionId: null,
    };
  }
  return SYSTEM_ACTOR;
}

function resolveProject(input: RecordEventInput): string | null {
  // Explicit null → untagged
  if (input.project === null) return null;
  // Explicit string → normalized
  if (typeof input.project === "string") {
    return normalizeProjectSlug(input.project);
  }
  // Undefined → inherit from agent if any
  if (input.actorAgentId) {
    const agent = getAgent(input.actorAgentId);
    if (agent?.project) return normalizeProjectSlug(agent.project);
  }
  return null;
}

/** Append an event to the L3 JSONL store, refresh L0 index, and provision
 *  L1/L2 skeletons if this is the first event for the project.
 *
 *  Returns the constructed event on success, null on any I/O error. */
export function recordEvent(input: RecordEventInput): MemoryEvent | null {
  try {
    if (!statsBootstrapped) bootstrapStatsFromDisk();

    const ts = input.ts ?? Date.now();
    const project = resolveProject(input);
    const actor = buildActor(input);

    const event: MemoryEvent = {
      v: MEMORY_SCHEMA_VERSION,
      id: makeEventId(ts),
      ts,
      project,
      actor,
      type: input.type,
      summary: truncateSummary(input.summary),
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
    };

    ensureMemoryDirs();
    appendEventLine(event);
    bumpStats(project, ts);
    if (project !== null) ensureProjectSkeleton(project);
    scheduleIndexRewrite();

    return event;
  } catch (err) {
    console.error(
      "[memory] recordEvent failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function appendEventLine(event: MemoryEvent): void {
  const file = getEventsFile(event.ts);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function bumpStats(project: string | null, ts: number): void {
  const key = statsKey(project);
  const cur = projectStats.get(key);
  if (cur) {
    cur.count += 1;
    if (ts > cur.latestTs) cur.latestTs = ts;
  } else {
    projectStats.set(key, { count: 1, latestTs: ts });
  }
}

// ── L0 index refresh ──────────────────────────────────────────────

/** Coalesce L0 index rewrites. recordEvent fires on every agent hook event;
 *  with many agents that's a steady stream of synchronous writeFileSync calls,
 *  each rewriting the whole index. The index is a coarse summary that doesn't
 *  need per-event freshness, so collapse bursts to at most one write per second.
 *  A dropped trailing write is self-healing: initMemory() rewrites it at the
 *  next startup, and the next event re-arms the timer. */
let indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIndexRewrite(): void {
  if (indexDebounceTimer) return;
  indexDebounceTimer = setTimeout(() => {
    indexDebounceTimer = null;
    try {
      rewriteIndex();
    } catch (err) {
      console.error(
        "[memory] debounced rewriteIndex failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }, 1000);
  indexDebounceTimer.unref?.();
}

function rewriteIndex(): void {
  const lines: string[] = [
    "# autonomOS Memory Index",
    "",
    `_Auto-generated. Last updated: ${new Date().toISOString()}._`,
    "",
    "| Project | Events | Latest |",
    "|---------|--------|--------|",
  ];

  // Sort by latestTs descending (most recent project first).
  const rows = Array.from(projectStats.entries()).sort(
    ([, a], [, b]) => b.latestTs - a.latestTs,
  );

  for (const [key, stats] of rows) {
    const display = key === UNTAGGED_KEY ? "_untagged_" : key;
    const latest = new Date(stats.latestTs).toISOString();
    lines.push(`| ${display} | ${stats.count} | ${latest} |`);
  }

  if (rows.length === 0) {
    lines.push("| _(no events yet)_ | 0 | — |");
  }

  lines.push("");
  lines.push("See [SCHEMA.md](SCHEMA.md) for the data model and read path.");
  lines.push("");

  writeFileSync(getIndexPath(), lines.join("\n"), { mode: 0o600 });
}

// ── L1/L2 skeleton provisioning ───────────────────────────────────

function ensureProjectSkeleton(slug: string): void {
  const dir = getProjectDir(slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const summaryPath = getProjectSummaryPath(slug);
  if (!existsSync(summaryPath)) {
    writeFileSync(
      summaryPath,
      [
        `# ${slug}`,
        "",
        "_Project summary placeholder._",
        "",
        "Will be auto-populated by v2 (Stop-hook summarization). Until then,",
        'drill down with `memory_query({level: "L3", project: ' +
          `"${slug}"})\`.`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }

  const timelinePath = getProjectTimelinePath(slug);
  if (!existsSync(timelinePath)) {
    writeFileSync(
      timelinePath,
      [
        `# ${slug} — Timeline`,
        "",
        "_Per-project chronological summary placeholder._",
        "",
        "Will be auto-populated by v3 (daily summarization cron). Until then,",
        "raw events are at `events/YYYY-MM/DD.jsonl`. Filter with",
        `\`memory_query({level: "L3", project: "${slug}"})\`.`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
}

// ── Bootstrap (rebuild stats from disk) ───────────────────────────

/** Scan all events on disk and rebuild the in-memory project stats cache.
 *  Called automatically on first recordEvent / queryMemory; can be called
 *  explicitly from server startup to warm the cache + refresh the L0 index. */
export function bootstrapStatsFromDisk(): void {
  projectStats.clear();
  statsBootstrapped = true;

  const eventsDir = getEventsDir();
  if (!existsSync(eventsDir)) return;

  let monthDirs: string[];
  try {
    monthDirs = readdirSync(eventsDir);
  } catch {
    return;
  }

  for (const monthDir of monthDirs) {
    const dayFiles = readSafe(`${eventsDir}/${monthDir}`);
    for (const dayFile of dayFiles) {
      if (!dayFile.endsWith(".jsonl")) continue;
      const path = `${eventsDir}/${monthDir}/${dayFile}`;
      let raw: string;
      try {
        raw = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as MemoryEvent;
          bumpStats(ev.project, ev.ts);
        } catch {
          // skip corrupt line
        }
      }
    }
  }
}

function readSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── Initialisation (write SCHEMA.md, ensure dirs, bootstrap stats) ─

let initialized = false;

/** Idempotent. Called from server startup. Writes SCHEMA.md (refreshing on
 *  schema-version change), ensures the directory layout, bootstraps stats,
 *  and writes an initial index.md. Safe to call from tests too. */
export function initMemory(): void {
  if (initialized) return;
  initialized = true;

  ensureMemoryDirs();
  writeFileSync(getSchemaDocPath(), SCHEMA_DOC, { mode: 0o600 });
  bootstrapStatsFromDisk();
  rewriteIndex();
}

/** Test hook: forget the bootstrap state. */
export function _resetMemoryForTesting(): void {
  projectStats.clear();
  statsBootstrapped = false;
  initialized = false;
  if (indexDebounceTimer) {
    clearTimeout(indexDebounceTimer);
    indexDebounceTimer = null;
  }
}

/** Test hook: flush a pending debounced index rewrite synchronously, so a test
 *  can assert on index.md right after recordEvent without waiting out the 1s
 *  debounce window. No-op when nothing is pending. */
export function _flushIndexForTesting(): void {
  if (indexDebounceTimer) {
    clearTimeout(indexDebounceTimer);
    indexDebounceTimer = null;
  }
  rewriteIndex();
}

// ── Querying ──────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function queryMemory(query: MemoryQuery): MemoryQueryResponse {
  const level: MemoryLevel = query.level ?? "L0";

  switch (level) {
    case "L0":
      return readMarkdownLevel("L0", getIndexPath());

    case "L1": {
      if (!query.project || !query.project.trim()) {
        throw new Error("L1 query requires `project`");
      }
      const slug = normalizeProjectSlug(query.project);
      if (!slug) throw new Error(`Invalid project slug: "${query.project}"`);
      return readMarkdownLevel("L1", getProjectSummaryPath(slug));
    }

    case "L2": {
      const slug = query.project ? normalizeProjectSlug(query.project) : null;
      if (slug) {
        return readMarkdownLevel("L2", getProjectTimelinePath(slug));
      }
      if (query.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
          throw new Error(
            `L2 query: date must be YYYY-MM-DD, got "${query.date}"`,
          );
        }
        return readMarkdownLevel("L2", getDailyPath(query.date));
      }
      throw new Error("L2 query requires `project` or `date`");
    }

    case "L3":
      return queryL3(query);

    default:
      throw new Error(`Unknown level: ${String(level)}`);
  }
}

function readMarkdownLevel(
  level: "L0" | "L1" | "L2",
  path: string,
): MemoryQueryResponse {
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    if (
      !(err instanceof Error) ||
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
    // ENOENT → empty content (skeleton not provisioned yet for this slug
    // or daily file not generated for this date)
  }
  return { level, content, sourcePath: path };
}

function queryL3(query: MemoryQuery): MemoryQueryResponse {
  if (!statsBootstrapped) bootstrapStatsFromDisk();

  // ── Direct fetch by id ────────────────────────────────────────
  if (query.id) {
    return { level: "L3", event: findEventById(query.id) };
  }

  // ── Filtered scan ─────────────────────────────────────────────
  const limit = clamp(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const projectFilter =
    query.project === undefined
      ? undefined
      : query.project === "untagged"
        ? null
        : normalizeProjectSlug(query.project);
  const typeSet = query.type ? new Set(query.type) : null;
  const actorLower = query.actor?.toLowerCase();

  // Walk JSONL files in reverse-chronological order so we can stop early
  // once `limit` results are collected.
  const files = listEventFilesDescending();
  const collected: MemoryEvent[] = [];

  for (const file of files) {
    if (collected.length >= limit) break;
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter(Boolean);
    // Reverse so newest-first within a file (JSONL is append-only chronological)
    for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
      let ev: MemoryEvent;
      try {
        ev = JSON.parse(lines[i]) as MemoryEvent;
      } catch {
        continue;
      }
      if (!matchesL3Filter(ev, projectFilter, typeSet, actorLower, query)) {
        continue;
      }
      collected.push(ev);
    }
  }

  return { level: "L3", events: collected };
}

function matchesL3Filter(
  ev: MemoryEvent,
  projectFilter: string | null | undefined,
  typeSet: Set<string> | null,
  actorLower: string | undefined,
  query: MemoryQuery,
): boolean {
  if (projectFilter !== undefined && ev.project !== projectFilter) return false;
  if (typeSet && !typeSet.has(ev.type)) return false;
  if (actorLower && ev.actor.agentName.toLowerCase() !== actorLower)
    return false;
  if (query.since !== undefined && ev.ts < query.since) return false;
  if (query.until !== undefined && ev.ts >= query.until) return false;
  return true;
}

function findEventById(id: string): MemoryEvent | null {
  // Id starts with a 12-hex ms timestamp → derive the JSONL file directly.
  const tsHex = id.split("-")[0];
  const ts = Number.parseInt(tsHex, 16);
  if (Number.isNaN(ts)) return null;

  const file = getEventsFile(ts);
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as MemoryEvent;
      if (ev.id === id) return ev;
    } catch {
      // skip
    }
  }
  return null;
}

/** All event JSONL files, sorted descending (newest first). */
function listEventFilesDescending(): string[] {
  const eventsDir = getEventsDir();
  if (!existsSync(eventsDir)) return [];

  const monthDirs = readSafe(eventsDir).sort().reverse();
  const files: string[] = [];
  for (const monthDir of monthDirs) {
    const dir = `${eventsDir}/${monthDir}`;
    const days = readSafe(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const d of days) files.push(`${dir}/${d}`);
  }
  return files;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
