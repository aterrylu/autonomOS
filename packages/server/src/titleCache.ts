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

/** Cached entry: the resolved title and the file mtime when we last parsed. */
interface CacheEntry {
  title: string;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

/** ~/.claude/projects/ base directory */
function projectsDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return join(home, ".claude", "projects");
}

/**
 * Replicate the SDK's path-to-dirname transform (d4 function).
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
 * Handles the SDK's truncated-name-with-hash-suffix convention.
 */
async function resolveProjectDir(cwd: string): Promise<string | null> {
  const base = projectsDir();
  const dirName = cwdToDirName(cwd);

  // Try exact match first
  const exact = join(base, dirName);
  try {
    await stat(exact);
    return exact;
  } catch {
    // If the dirname was truncated, look for prefix match
    if (dirName.length <= 200) return null;
    const prefix = dirName.slice(0, 200);
    try {
      const dir = await opendir(base);
      for await (const entry of dir) {
        if (entry.isDirectory() && entry.name.startsWith(`${prefix}-`)) {
          return join(base, entry.name);
        }
      }
    } catch {
      // projects dir doesn't exist
    }
    return null;
  }
}

/**
 * Extract the last custom-title from a JSONL file by reading from the end.
 *
 * Strategy: read the last TAIL_SIZE bytes, split into lines, scan backwards
 * for a line containing "custom-title". This avoids reading multi-MB files
 * while catching titles that the SDK's 64KB window misses.
 *
 * If the title isn't in the tail, we do a targeted forward scan of just
 * the lines containing "custom-title" (using readline for efficiency).
 */
const TAIL_SIZE = 256 * 1024; // 256KB tail — covers most renames

async function extractTitle(filePath: string): Promise<string | null> {
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await open(filePath, "r");
    const stats = await fh.stat();
    const size = stats.size;

    if (size === 0) return null;

    // Phase 1: scan tail (fast path — covers recent renames)
    const tailOffset = Math.max(0, size - TAIL_SIZE);
    const readSize = Math.min(size, TAIL_SIZE);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, tailOffset);
    const tail = buf.toString("utf8", 0, bytesRead);

    const tailTitle = scanForTitle(tail);
    if (tailTitle) return tailTitle;

    // Phase 2: if file is larger than tail and title wasn't found,
    // scan the head portion (title might be written early in session)
    if (tailOffset > 0) {
      const headSize = Math.min(size, TAIL_SIZE);
      const headBuf = Buffer.allocUnsafe(headSize);
      const headResult = await fh.read(headBuf, 0, headSize, 0);
      const head = headBuf.toString("utf8", 0, headResult.bytesRead);
      const headTitle = scanForTitle(head);
      if (headTitle) return headTitle;
    }

    // Phase 3: for very large files where title is in the middle,
    // do a streaming scan. This is rare but handles edge cases.
    if (size > TAIL_SIZE * 2) {
      return await streamScanForTitle(fh, size);
    }

    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Scan a string buffer for the LAST custom-title entry.
 * Returns the title string or null.
 */
function scanForTitle(content: string): string | null {
  // Scan backwards through lines for the last custom-title entry
  let lastTitle: string | null = null;
  let searchFrom = content.length;

  while (searchFrom > 0) {
    const idx = content.lastIndexOf('"type":"custom-title"', searchFrom);
    const idx2 = content.lastIndexOf('"type": "custom-title"', searchFrom);
    const pos = Math.max(idx, idx2);
    if (pos === -1) break;

    // Find the line boundaries
    const lineStart = content.lastIndexOf("\n", pos) + 1;
    let lineEnd = content.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = content.length;

    const line = content.slice(lineStart, lineEnd);
    try {
      const parsed = JSON.parse(line);
      if (parsed.customTitle) {
        lastTitle = parsed.customTitle;
        break; // We found the last one (scanning backwards)
      }
    } catch {
      // Truncated line at buffer boundary — try next
    }
    searchFrom = pos - 1;
  }

  return lastTitle;
}

/**
 * Streaming scan for very large files — reads in chunks looking for
 * custom-title entries. Only used when head+tail scan both miss.
 */
async function streamScanForTitle(
  fh: import("node:fs/promises").FileHandle,
  size: number,
): Promise<string | null> {
  const CHUNK = 256 * 1024;
  let lastTitle: string | null = null;
  let offset = 0;
  // Keep a small overlap to handle lines split across chunks
  let leftover = "";

  while (offset < size) {
    const readSize = Math.min(CHUNK, size - offset);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, offset);
    if (bytesRead === 0) break;

    const chunk = leftover + buf.toString("utf8", 0, bytesRead);

    // Quick check: does this chunk even contain custom-title?
    if (
      chunk.includes('"type":"custom-title"') ||
      chunk.includes('"type": "custom-title"')
    ) {
      const title = scanForTitle(chunk);
      if (title) lastTitle = title;
    }

    // Keep the last partial line for the next chunk
    const lastNewline = chunk.lastIndexOf("\n");
    leftover = lastNewline >= 0 ? chunk.slice(lastNewline + 1) : chunk;
    offset += bytesRead;
  }

  return lastTitle;
}

/**
 * Look up the custom title for a session, using mtime-based caching.
 *
 * @param sessionId - The Claude session UUID
 * @param cwd - The working directory (used to locate the project dir)
 * @returns The custom title, or null if none found
 */
export async function getCachedTitle(
  sessionId: string,
  cwd: string,
): Promise<string | null> {
  const projectDir = await resolveProjectDir(cwd);
  if (!projectDir) return null;

  const filePath = join(projectDir, `${sessionId}.jsonl`);

  let mtimeMs: number;
  try {
    const stats = await stat(filePath);
    mtimeMs = stats.mtimeMs;
  } catch {
    return null; // File doesn't exist
  }

  // Check cache — if mtime matches, return cached title
  const cached = cache.get(sessionId);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.title;
  }

  // Parse the file
  const title = await extractTitle(filePath);
  if (title) {
    cache.set(sessionId, { title, mtimeMs });
  } else {
    // Remove stale cache entry if title was removed (unlikely but safe)
    cache.delete(sessionId);
  }

  return title;
}

/**
 * Batch-resolve titles for multiple sessions.
 * Runs all lookups concurrently for efficiency.
 */
export async function batchGetTitles(
  sessions: Array<{ sessionId: string; cwd: string }>,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  await Promise.all(
    sessions.map(async ({ sessionId, cwd }) => {
      const title = await getCachedTitle(sessionId, cwd);
      if (title) results.set(sessionId, title);
    }),
  );

  return results;
}
