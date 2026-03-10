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

import { opendir, open, stat } from "node:fs/promises";
import { join } from "node:path";

const TITLE_MARKERS = [
  '"type":"custom-title"',
  '"type": "custom-title"',
] as const;

/** Cached entry: the resolved title and the file mtime when we last parsed. */
interface CacheEntry {
  title: string;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

/** Cache for resolveProjectDir — avoids repeated stat() for the same cwd. */
const projectDirCache = new Map<string, string | null>();

/** ~/.claude/projects/ base directory */
function projectsDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return join(home, ".claude", "projects");
}

/**
 * Replicate the SDK's path-to-dirname transform (d4 function in sdk.mjs v0.2.71).
 * Replaces all non-alphanumeric chars with '-', truncates at 200 chars,
 * and appends a hash suffix if truncated.
 */
function cwdToDirName(cwd: string): string {
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

/**
 * Resolve the project directory for a given cwd.
 * Results are cached in memory to avoid repeated stat() calls
 * when multiple sessions share the same working directory.
 */
async function resolveProjectDir(cwd: string): Promise<string | null> {
  const cached = projectDirCache.get(cwd);
  if (cached !== undefined) return cached;

  const base = projectsDir();
  const dirName = cwdToDirName(cwd);

  // Try exact match first
  const exact = join(base, dirName);
  try {
    await stat(exact);
    projectDirCache.set(cwd, exact);
    return exact;
  } catch {
    // If the dirname was truncated, look for prefix match
    if (dirName.length <= 200) {
      projectDirCache.set(cwd, null);
      return null;
    }
    const prefix = dirName.slice(0, 200);
    try {
      const dir = await opendir(base);
      for await (const entry of dir) {
        if (entry.isDirectory() && entry.name.startsWith(`${prefix}-`)) {
          const result = join(base, entry.name);
          projectDirCache.set(cwd, result);
          return result;
        }
      }
    } catch {
      // projects dir doesn't exist
    }
    projectDirCache.set(cwd, null);
    return null;
  }
}

/**
 * Extract the last custom-title from a JSONL file.
 *
 * Strategy: read tail first (most renames are recent), then head,
 * then stream the middle gap for very large files. Uses a pre-opened
 * file handle and known size to avoid redundant stat() calls.
 */
const TAIL_SIZE = 256 * 1024; // 256KB — covers most renames

function containsTitleMarker(s: string): boolean {
  return TITLE_MARKERS.some((m) => s.includes(m));
}

async function extractTitle(
  fh: import("node:fs/promises").FileHandle,
  size: number,
): Promise<string | null> {
  if (size === 0) return null;

  // Phase 1: scan tail (fast path — covers recent renames)
  const tailOffset = Math.max(0, size - TAIL_SIZE);
  const readSize = Math.min(size, TAIL_SIZE);
  const buf = Buffer.allocUnsafe(readSize);
  const { bytesRead } = await fh.read(buf, 0, readSize, tailOffset);
  const tail = buf.toString("utf8", 0, bytesRead);

  const tailTitle = scanForTitle(tail);
  if (tailTitle) return tailTitle;

  // Phase 2: if file is larger than tail, scan head
  if (tailOffset > 0) {
    const headSize = Math.min(size, TAIL_SIZE);
    const headBuf = Buffer.allocUnsafe(headSize);
    const headResult = await fh.read(headBuf, 0, headSize, 0);
    const head = headBuf.toString("utf8", 0, headResult.bytesRead);
    const headTitle = scanForTitle(head);
    if (headTitle) return headTitle;
  }

  // Phase 3: for files > 512KB, head+tail leave a gap in the middle.
  // Stream only the unscanned region [TAIL_SIZE, size - TAIL_SIZE].
  if (size > TAIL_SIZE * 2) {
    return await streamScanForTitle(fh, TAIL_SIZE, size - TAIL_SIZE);
  }

  return null;
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
 * Streaming scan for the middle gap of very large files.
 * Reads in chunks, only parses chunks containing title markers.
 * Forward iteration + per-chunk backward scan = globally last title.
 */
async function streamScanForTitle(
  fh: import("node:fs/promises").FileHandle,
  startOffset: number,
  endOffset: number,
): Promise<string | null> {
  const CHUNK = 256 * 1024;
  let lastTitle: string | null = null;
  let offset = startOffset;
  let leftover = "";

  while (offset < endOffset) {
    const readSize = Math.min(CHUNK, endOffset - offset);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, offset);
    if (bytesRead === 0) break;

    const chunk = leftover + buf.toString("utf8", 0, bytesRead);

    if (containsTitleMarker(chunk)) {
      const title = scanForTitle(chunk);
      if (title) lastTitle = title;
    }

    const lastNewline = chunk.lastIndexOf("\n");
    leftover = lastNewline >= 0 ? chunk.slice(lastNewline + 1) : chunk;
    offset += bytesRead;
  }

  return lastTitle;
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
    const { mtimeMs, size } = stats;

    // Check cache — if mtime matches, return cached title
    const cached = cache.get(sessionId);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.title;
    }

    // Parse the file using the already-open handle
    const title = await extractTitle(fh, size);
    if (title) {
      cache.set(sessionId, { title, mtimeMs });
    } else {
      cache.delete(sessionId);
    }
    return title;
  } catch {
    return null;
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

  // Resolve each unique cwd once, then look up sessions concurrently
  const lookups: Promise<void>[] = [];
  for (const [cwd, sessionIds] of byCwd) {
    lookups.push(
      (async () => {
        const projectDir = await resolveProjectDir(cwd);
        if (!projectDir) return;
        await Promise.all(
          sessionIds.map(async (sessionId) => {
            const title = await getCachedTitle(sessionId, projectDir);
            if (title) results.set(sessionId, title);
          }),
        );
      })(),
    );
  }
  await Promise.all(lookups);

  // Prune cache entries for sessions no longer in the batch
  const knownIds = new Set(sessions.map((s) => s.sessionId));
  for (const key of cache.keys()) {
    if (!knownIds.has(key)) cache.delete(key);
  }

  return results;
}
