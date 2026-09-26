/**
 * Codex and Gemini sessions for the Projects panel, read straight from each
 * CLI's own storage — read-only, bounded, mtime-cached, and tolerant of any
 * malformed file (skipped, never fatal). Formats measured on codex 0.154 and
 * gemini 0.46:
 *
 * - Codex: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. Line 1 is
 *   `{type:"session_meta", payload:{id, cwd, originator, …}}` (several KB: it
 *   inlines instructions). The first `event_msg` `user_message` is the prompt.
 * - Gemini: `($GEMINI_CLI_HOME || $HOME)/.gemini/tmp/<slug>/chats/
 *   session-<ts>-<id8>.jsonl`. Line 1 is `{sessionId, projectHash, startTime,
 *   lastUpdated, kind}`; `<slug>/.project_root` holds the project's cwd; the
 *   first `{type:"user"}` line is the prompt. `gemini --resume <uuid>` only
 *   searches the CURRENT directory's project (see findGeminiSession).
 *
 * Bounds: at most MAX_FILES per scan (newest first, so the cap drops the OLDEST
 * history), at most MAX_HEAD_BYTES read per file, and a file whose mtime+size
 * didn't change is never re-read.
 */

import type { Dirent } from "node:fs";
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectSession } from "@autonomos/core";

export interface ScannedSession {
  cwd: string;
  session: ProjectSession;
}

/** Files read per scan, per runtime — newest first. */
export const MAX_FILES = 400;
/** Bytes read from the head of one session file. */
export const MAX_HEAD_BYTES = 256 * 1024;
/** Summary length on the wire. */
const SUMMARY_CHARS = 120;

type Env = Record<string, string | undefined>;

// ── shared helpers ──────────────────────────────────────────────

/** The first ≤maxBytes of a file, and whether that was ALL of it. */
interface Head {
  text: string;
  truncated: boolean;
}

/** At most `maxBytes` from the start of a file, as UTF-8 (a split multi-byte
 *  char at the cut becomes U+FFFD, harmless: only whole lines are parsed). */
async function readHead(path: string, maxBytes: number): Promise<Head> {
  const fh = await open(path, "r");
  try {
    // One byte over the cap tells "exactly maxBytes long" from "truncated".
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    return {
      text: buf.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await fh.close();
  }
}

function readHeadSync(path: string, maxBytes: number): Head {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(fd, buf, 0, maxBytes + 1, 0);
    return {
      text: buf.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    closeSync(fd);
  }
}

/** Complete JSON lines from a head. When the head was TRUNCATED its last line
 *  may be torn, so it's dropped; a whole file keeps its last line even without
 *  a trailing newline. Malformed lines are skipped. */
function* jsonLines(head: Head): Generator<Record<string, unknown>> {
  const lines = head.text.split("\n");
  if (head.truncated) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") yield v as Record<string, unknown>;
    } catch {
      // malformed line: skip
    }
  }
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > SUMMARY_CHARS
    ? `${one.slice(0, SUMMARY_CHARS - 1)}…`
    : one;
}

/** autonomOS prepends its system context to a Gemini prompt, separated by
 *  `\n\n---\n\n` (gemini-cli.ts buildArgs) — show the task, not the preamble. */
function stripInjectedContext(text: string): string {
  const i = text.lastIndexOf("\n\n---\n\n");
  return i >= 0 ? text.slice(i + 7) : text;
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return []; // absent or unreadable: nothing to list from here
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  row: ScannedSession | null;
}
const codexCache = new Map<string, CacheEntry>();
const geminiCache = new Map<string, CacheEntry>();

/** Parse one file through its runtime's cache (keyed by path; valid while
 *  mtime and size are unchanged). A file that can't be read or parsed caches
 *  as null, so a malformed file isn't re-read every poll either. */
async function cachedRow(
  cache: Map<string, CacheEntry>,
  path: string,
  mtimeMs: number,
  size: number,
  parse: (head: Head) => ScannedSession | null,
): Promise<ScannedSession | null> {
  // Callers get a COPY: the route rewrites a managed row's sessionId, and
  // mutating the cached object made every later poll miss the match.
  const copy = (r: ScannedSession | null): ScannedSession | null =>
    r && { cwd: r.cwd, session: { ...r.session, lastModified: mtimeMs } };
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return copy(hit.row);
  let row: ScannedSession | null = null;
  try {
    row = parse(await readHead(path, MAX_HEAD_BYTES));
  } catch {
    row = null;
  }
  cache.set(path, { mtimeMs, size, row });
  return copy(row);
}

/** Newest-first by mtime, capped — stat is the only per-file cost for the
 *  files the cap keeps OUT, and names already sort by date for Codex. */
async function newestFiles(
  paths: string[],
  max: number,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const path of paths) {
    try {
      const s = await stat(path);
      if (s.isFile()) out.push({ path, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // vanished between readdir and stat: skip
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, max);
}

// ── Codex ───────────────────────────────────────────────────────

export function codexHome(env: Env = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

export function parseCodexHead(head: Head): ScannedSession | null {
  let meta: { id?: unknown; cwd?: unknown; originator?: unknown } | undefined;
  let prompt: string | undefined;
  // Two places a prompt can be, both seen on 0.154: an `event_msg`
  // `user_message` (the interactive TUI), or — for a thread driven through the
  // app-server, as every autonomOS agent is — ONLY a `response_item` user
  // message, after synthetic `<environment_context>`-style blocks we skip.
  let itemPrompt: string | undefined;
  for (const line of jsonLines(head)) {
    const payload = line.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (!meta && line.type === "session_meta") meta = payload;
    else if (
      !prompt &&
      line.type === "event_msg" &&
      payload.type === "user_message" &&
      typeof payload.message === "string"
    ) {
      prompt = payload.message;
    } else if (
      !itemPrompt &&
      line.type === "response_item" &&
      payload.role === "user" &&
      Array.isArray(payload.content)
    ) {
      const text = (payload.content as Array<{ text?: unknown }>)
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .join(" ")
        .trim();
      if (text && !text.startsWith("<")) itemPrompt = text;
    }
    if (meta && prompt) break;
  }
  prompt ??= itemPrompt;
  if (!meta || typeof meta.id !== "string" || typeof meta.cwd !== "string")
    return null;
  const originator =
    typeof meta.originator === "string" ? meta.originator : undefined;
  return {
    cwd: meta.cwd,
    session: {
      sessionId: meta.id,
      provider: "codex",
      summary: prompt ? clip(prompt) : "(no prompt yet)",
      lastModified: 0,
      firstPrompt: prompt ? clip(prompt) : undefined,
      // "autonomos" when an autonomOS daemon created it (its originator names
      // autonomOS), else the CLI's own ("codex_cli_rs", "codex_exec", …).
      originator: originator?.startsWith("autonomos")
        ? "autonomos"
        : "external",
    },
  };
}

/**
 * The newest ≤MAX_FILES Codex sessions. Walks the date-bucketed tree newest
 * day first and stops collecting once it has enough candidates, so a huge
 * history costs directory listings of recent days, not a stat of every file.
 */
export async function listCodexSessions(
  env: Env = process.env,
): Promise<ScannedSession[]> {
  const root = join(codexHome(env), "sessions");
  const candidates: string[] = [];
  const desc = (a: Dirent, b: Dirent) => (a.name < b.name ? 1 : -1);
  outer: for (const y of (await listDir(root))
    .filter((d) => d.isDirectory())
    .sort(desc)) {
    for (const m of (await listDir(join(root, y.name)))
      .filter((d) => d.isDirectory())
      .sort(desc)) {
      for (const d of (await listDir(join(root, y.name, m.name)))
        .filter((e) => e.isDirectory())
        .sort(desc)) {
        const dir = join(root, y.name, m.name, d.name);
        for (const f of await listDir(dir)) {
          if (
            f.isFile() &&
            f.name.startsWith("rollout-") &&
            f.name.endsWith(".jsonl")
          )
            candidates.push(join(dir, f.name));
        }
        // Whole days only, so the newest-by-mtime sort below sees every file
        // of the last day it takes; 2× headroom for mtime-vs-name ordering.
        if (candidates.length >= MAX_FILES * 2) break outer;
      }
    }
  }
  const rows: ScannedSession[] = [];
  for (const f of await newestFiles(candidates, MAX_FILES)) {
    const row = await cachedRow(
      codexCache,
      f.path,
      f.mtimeMs,
      f.size,
      parseCodexHead,
    );
    if (row) rows.push(row);
  }
  return rows;
}

// ── Gemini ──────────────────────────────────────────────────────

export function geminiTmpDir(env: Env = process.env): string {
  return join(env.GEMINI_CLI_HOME || env.HOME || homedir(), ".gemini", "tmp");
}

export function parseGeminiHead(
  head: Head,
  cwd: string,
): ScannedSession | null {
  let header: { sessionId?: unknown; kind?: unknown } | undefined;
  let prompt: string | undefined;
  for (const line of jsonLines(head)) {
    if (!header && typeof line.sessionId === "string") header = line;
    else if (!prompt && line.type === "user" && Array.isArray(line.content)) {
      const text = (line.content as Array<{ text?: unknown }>)
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .join(" ");
      if (text.trim()) prompt = stripInjectedContext(text);
    }
    if (header && prompt) break;
  }
  if (!header || typeof header.sessionId !== "string") return null;
  // Subagent/side sessions aren't something a user resumes.
  if (header.kind !== undefined && header.kind !== "main") return null;
  return {
    cwd,
    session: {
      sessionId: header.sessionId,
      provider: "gemini-cli",
      summary: prompt ? clip(prompt) : "(no prompt yet)",
      lastModified: 0,
      firstPrompt: prompt ? clip(prompt) : undefined,
    },
  };
}

/** Every Gemini project dir with its recorded cwd (`.project_root`). */
async function geminiProjects(
  env: Env,
): Promise<Array<{ dir: string; root: string }>> {
  const tmp = geminiTmpDir(env);
  const out: Array<{ dir: string; root: string }> = [];
  for (const slug of await listDir(tmp)) {
    if (!slug.isDirectory()) continue;
    const dir = join(tmp, slug.name);
    try {
      const root = (await readFile(join(dir, ".project_root"), "utf8")).trim();
      if (root) out.push({ dir, root });
    } catch {
      // not a project dir (bin/, logs…) or unreadable: skip
    }
  }
  return out;
}

export async function listGeminiSessions(
  env: Env = process.env,
): Promise<ScannedSession[]> {
  const byPath = new Map<string, string>(); // file → its project's cwd
  for (const { dir, root } of await geminiProjects(env)) {
    const chats = join(dir, "chats");
    for (const f of await listDir(chats)) {
      if (
        f.isFile() &&
        f.name.startsWith("session-") &&
        f.name.endsWith(".jsonl")
      )
        byPath.set(join(chats, f.name), root);
    }
  }
  const rows: ScannedSession[] = [];
  for (const f of await newestFiles([...byPath.keys()], MAX_FILES)) {
    const cwd = byPath.get(f.path) as string;
    const row = await cachedRow(geminiCache, f.path, f.mtimeMs, f.size, (h) =>
      parseGeminiHead(h, cwd),
    );
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Is Gemini session `sessionId` saved for `cwd`'s project — the only place
 * `gemini --resume <uuid>` looks? Three-state, like the Codex thread probe:
 * true = found; false = POSITIVELY absent (no Gemini storage, no project for
 * this cwd, or no such session in it); THROWS when it can't tell (unreadable
 * storage), so the runtime fails open and tries the resume.
 *
 * Synchronous: it's the provider's `hasResumableSession` pre-flight, which the
 * runtime calls synchronously (Claude Code's is a statSync). Bounded: one
 * .project_root read per Gemini project, and only the matching project's
 * chats are listed; only files ending in the id's 8-char prefix are opened.
 */
export function findGeminiSession(
  cwd: string,
  sessionId: string,
  env: Env = process.env,
): boolean {
  const tmp = geminiTmpDir(env);
  let slugs: Dirent[];
  try {
    slugs = readdirSync(tmp, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const wanted = new Set([cwd]);
  try {
    wanted.add(realpathSync(cwd));
  } catch {
    // cwd gone or unresolvable: match the raw path only
  }
  const suffix = `-${sessionId.slice(0, 8)}.jsonl`;
  let cantTell: unknown;
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = join(tmp, slug.name);
    let root: string;
    try {
      root = readFileSync(join(dir, ".project_root"), "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") cantTell = err;
      continue;
    }
    if (!wanted.has(root)) continue;
    let files: Dirent[];
    try {
      files = readdirSync(join(dir, "chats"), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") cantTell = err;
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(suffix)) continue;
      try {
        // Only the header line names the session.
        const first = jsonLines(
          readHeadSync(join(dir, "chats", f.name), 4096),
        ).next();
        if (!first.done && first.value.sessionId === sessionId) return true;
      } catch (err) {
        cantTell = err;
      }
    }
  }
  if (cantTell) throw cantTell;
  return false;
}

/** For tests. */
export function _resetSessionScannerCachesForTesting(): void {
  codexCache.clear();
  geminiCache.clear();
}
