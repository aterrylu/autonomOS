/**
 * JSONL-based title cache — workaround for SDK's unreliable customTitle.
 *
 * The Claude Agent SDK's listSessions() reads only the first/last 64KB of each
 * session JSONL file, so custom-title entries often fall outside that window as
 * sessions grow. This module scans the actual files efficiently and caches
 * results keyed by (sessionId, mtime) so repeated polls are cheap.
 *
 * Resolution order (applied in projects route):
 *   SDK customTitle → mtime-validated cache → JSONL fallback → SDK summary
 */

import { realpathSync } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { join } from "node:path";

const TITLE_MARKERS = [
  '"type":"custom-title"',
  '"type": "custom-title"',
] as const;

/** Cached entry: the resolved title and the file mtime when we last parsed. */
interface CacheEntry {
  /** null = scanned, no custom title (cached too: most sessions have none,
   *  and re-scanning them on every Projects poll was a recurring ~150ms
   *  event-loop block under a busy fleet). */
  title: string | null;
  mtimeMs: number;
  /** Matched with mtime: on a coarse-timestamp filesystem an append can land
   *  within the same mtime tick, but never without growing the file. */
  size: number;
  /** Offset just past the last COMPLETE line scanned. Session files are
   *  append-only, so a grown file is scanned from here on, not from 0 — an
   *  active 500MB session costs its new turns per poll, not 500MB. */
  scannedTo: number;
  /** The file this entry describes (a session id can resolve to another
   *  project dir) and its inode (a replaced file is a new one): resuming at
   *  `scannedTo` is only valid for the same file, appended to. */
  path: string;
  ino: number;
}

const cache = new Map<string, CacheEntry>();

/** Session files read at once by {@link batchGetTitles}. */
const TITLE_READ_CONCURRENCY = 8;

/** Cache for resolveProjectDir — avoids repeated stat() for the same cwd.
 *  Negative results (null) expire after 5 minutes so new projects are discovered. */
const projectDirCache = new Map<string, { path: string | null; at: number }>();
const PROJECT_DIR_NEGATIVE_TTL = 5 * 60 * 1000;

/** ~/.claude/projects/ base directory */
export function projectsDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return join(home, ".claude", "projects");
}

/**
 * Replicate the SDK's path-to-dirname transform (d4 function in sdk.mjs v0.2.71).
 * Replaces all non-alphanumeric chars with '-', truncates at 200 chars,
 * and appends a hash suffix if truncated.
 */
export function cwdToDirName(cwd: string): string {
  const MAX = 200;
  const replaced = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= MAX) return replaced;
  // Simple hash matching SDK's OU() function
  let h = 0;
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  }
  const hash = Math.abs(h).toString(36);
  return `${replaced.slice(0, MAX)}-${hash}`;
}

/** The cwd spellings CC may have filed a session under: the realpath first
 *  (what current CC writes), then the path as given. Deduplicated; an
 *  unresolvable cwd just yields the raw path. Exported for tests. */
export function candidateProjectCwds(cwd: string): string[] {
  let real: string | undefined;
  try {
    real = realpathSync(cwd);
  } catch {
    real = undefined;
  }
  return real && real !== cwd ? [real, cwd] : [cwd];
}

/**
 * Resolve the project directory for a given cwd.
 * Results are cached in memory to avoid repeated stat() calls
 * when multiple sessions share the same working directory.
 */
async function resolveProjectDir(cwd: string): Promise<string | null> {
  const cached = projectDirCache.get(cwd);
  if (cached !== undefined) {
    // Positive results are cached forever; negative results expire
    if (cached.path !== null) return cached.path;
    if (Date.now() - cached.at < PROJECT_DIR_NEGATIVE_TTL) return null;
  }

  const base = projectsDir();
  const now = Date.now();

  // Try exact matches first: CC files a session under the REALPATH of its cwd,
  // so a symlinked cwd (/tmp or any /var/folders tmpdir on macOS, a symlinked
  // project dir) must be looked up resolved; the raw spelling covers older
  // layouts. Without this, titles for symlinked cwds were silently missing.
  for (const spelling of candidateProjectCwds(cwd)) {
    const exact = join(base, cwdToDirName(spelling));
    try {
      await stat(exact);
      projectDirCache.set(cwd, { path: exact, at: now });
      return exact;
    } catch {
      // try the next spelling
    }
  }
  const dirName = cwdToDirName(cwd);
  {
    // If the dirname was truncated, look for prefix match
    if (dirName.length <= 200) {
      projectDirCache.set(cwd, { path: null, at: now });
      return null;
    }
    const prefix = dirName.slice(0, 200);
    try {
      const dir = await opendir(base);
      for await (const entry of dir) {
        if (entry.isDirectory() && entry.name.startsWith(`${prefix}-`)) {
          const result = join(base, entry.name);
          projectDirCache.set(cwd, { path: result, at: now });
          return result;
        }
      }
    } catch {
      // projects dir doesn't exist
    }
    projectDirCache.set(cwd, { path: null, at: now });
    return null;
  }
}

const SCAN_CHUNK_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024; // covers most renames
const MARKER_BYTES = TITLE_MARKERS.map((m) => Buffer.from(m));

/**
 * Scan the complete lines of [from, to) forward for the LAST custom title,
 * returning it and the offset just past the last newline seen (`end`; equals
 * `from` when no line completed). A chunk is decoded only if it holds a title
 * marker — most sessions are untitled, and decoding every byte of a large
 * file was the cost. A trailing partial line (still being written) is left
 * for the next scan, which resumes at `end`.
 */
async function scanRange(
  fh: import("node:fs/promises").FileHandle,
  from: number,
  to: number,
): Promise<{ title: string | null; end: number }> {
  let title: string | null = null;
  let end = from;
  let offset = from;
  // Pieces of the line whose END we haven't reached (kept as parts so a line
  // spanning many chunks is concatenated once, not once per chunk).
  let pending: Buffer[] = [];
  while (offset < to) {
    const len = Math.min(SCAN_CHUNK_BYTES, to - offset);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    if (bytesRead === 0) break;
    const data = buf.subarray(0, bytesRead);
    const chunkStart = offset;
    offset += bytesRead;
    const nl = data.lastIndexOf(0x0a);
    if (nl === -1) {
      pending.push(data);
      continue;
    }
    const complete =
      pending.length > 0
        ? Buffer.concat([...pending, data.subarray(0, nl + 1)])
        : data.subarray(0, nl + 1);
    if (MARKER_BYTES.some((m) => complete.indexOf(m) !== -1)) {
      const t = scanForTitle(complete.toString("utf8"));
      if (t) title = t;
    }
    end = chunkStart + nl + 1;
    pending = nl + 1 < data.length ? [data.subarray(nl + 1)] : [];
  }
  return { title, end };
}

/**
 * Whether the open file is `prev`'s file with bytes appended: it grew (same
 * size with a new mtime is a rewrite), and the byte before `scannedTo` is
 * still the newline that ended the last line scanned. `prev` is only offered
 * for the same path + inode (see getCachedTitle).
 */
async function appendedTo(
  fh: import("node:fs/promises").FileHandle,
  size: number,
  prev: CacheEntry,
): Promise<boolean> {
  if (size <= prev.size) return false;
  if (prev.scannedTo === 0) return true;
  const b = Buffer.alloc(1);
  const { bytesRead } = await fh.read(b, 0, 1, prev.scannedTo - 1);
  return bytesRead === 1 && b[0] === 0x0a;
}

/**
 * The last custom title in a session file, reusing `prev` when the file only
 * grew since it was scanned. Cold: the tail first (a recent rename ends the
 * search), else the whole file once — chunked, async, marker-gated.
 */
async function extractTitle(
  fh: import("node:fs/promises").FileHandle,
  size: number,
  prev: CacheEntry | undefined,
): Promise<{ title: string | null; scannedTo: number }> {
  if (size === 0) return { title: null, scannedTo: 0 };
  if (prev && (await appendedTo(fh, size, prev))) {
    const r = await scanRange(fh, prev.scannedTo, size);
    return { title: r.title ?? prev.title, scannedTo: r.end };
  }
  const tailFrom = Math.max(0, size - TAIL_BYTES);
  if (tailFrom > 0) {
    const tail = await scanRange(fh, tailFrom, size);
    if (tail.title) return { title: tail.title, scannedTo: tail.end };
  }
  const all = await scanRange(fh, 0, size);
  return { title: all.title, scannedTo: all.end };
}

/**
 * Scan a string buffer for the LAST custom-title entry (backwards).
 */
function scanForTitle(content: string): string | null {
  let searchFrom = content.length;

  while (searchFrom > 0) {
    let pos = -1;
    for (const marker of TITLE_MARKERS) {
      const idx = content.lastIndexOf(marker, searchFrom);
      if (idx > pos) pos = idx;
    }
    if (pos === -1) break;

    // Find the line boundaries
    const lineStart = content.lastIndexOf("\n", pos) + 1;
    let lineEnd = content.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = content.length;

    const line = content.slice(lineStart, lineEnd);
    try {
      const parsed = JSON.parse(line);
      if (parsed.customTitle) return parsed.customTitle;
    } catch {
      // Truncated line at buffer boundary — try next
    }
    searchFrom = pos - 1;
  }

  return null;
}

/**
 * Look up the custom title for a session, using mtime-based caching.
 * Uses a single file handle for both stat and read to avoid redundant syscalls.
 */
async function getCachedTitle(
  sessionId: string,
  projectDir: string,
): Promise<string | null> {
  const filePath = join(projectDir, `${sessionId}.jsonl`);

  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await open(filePath, "r");
    const stats = await fh.stat();
    const { mtimeMs, size, ino } = stats;

    // Only an entry for this very file counts (same path, same inode).
    const entry = cache.get(sessionId);
    const cached =
      entry && entry.path === filePath && entry.ino === ino ? entry : undefined;
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.title;
    }

    // Parse the file (only its new bytes, if it was just appended to)
    const { title, scannedTo } = await extractTitle(fh, size, cached);
    cache.set(sessionId, {
      title,
      mtimeMs,
      size,
      scannedTo,
      path: filePath,
      ino,
    });
    return title;
  } catch (err) {
    // An absent file has no title; a transient failure (EMFILE, a torn read)
    // keeps the one we knew.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return cache.get(sessionId)?.title ?? null;
  } finally {
    await fh?.close();
  }
}

/**
 * Batch-resolve titles for multiple sessions.
 * Groups by cwd to resolve each project directory once,
 * then looks up individual session files concurrently.
 * Prunes cache entries for sessions not in the current batch.
 */
export async function batchGetTitles(
  sessions: Array<{ sessionId: string; cwd: string }>,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Group sessions by cwd to avoid repeated resolveProjectDir calls
  const byCwd = new Map<string, string[]>();
  for (const { sessionId, cwd } of sessions) {
    let list = byCwd.get(cwd);
    if (!list) {
      list = [];
      byCwd.set(cwd, list);
    }
    list.push(sessionId);
  }

  // Resolve each unique cwd once, then read session files through a small
  // pool: an unbounded Promise.all opened every session file at once on a
  // cold start (thousands of handles + a 256KB buffer each).
  const jobs: Array<{ sessionId: string; projectDir: string }> = [];
  await Promise.all(
    [...byCwd].map(async ([cwd, sessionIds]) => {
      const projectDir = await resolveProjectDir(cwd);
      if (projectDir)
        for (const sessionId of sessionIds)
          jobs.push({ sessionId, projectDir });
    }),
  );
  let next = 0;
  const lookups = Array.from(
    { length: Math.min(TITLE_READ_CONCURRENCY, jobs.length) },
    async () => {
      while (next < jobs.length) {
        const { sessionId, projectDir } = jobs[next++];
        const title = await getCachedTitle(sessionId, projectDir);
        if (title) results.set(sessionId, title);
      }
    },
  );
  await Promise.all(lookups);

  // Prune cache entries for sessions no longer in the batch
  const knownIds = new Set(sessions.map((s) => s.sessionId));
  for (const key of cache.keys()) {
    if (!knownIds.has(key)) cache.delete(key);
  }

  return results;
}
