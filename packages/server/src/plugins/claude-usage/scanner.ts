/**
 * JSONL usage scanner — aggregates token usage from Claude Code session files.
 *
 * Scans ~/.claude/projects/ for assistant entries with message.usage fields.
 * Uses mtime-based caching per file so repeated polls are cheap.
 */

import { open, opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectsDir } from "../../titleCache.js";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
}

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  resetsAt?: number;
  type?: string;
}

export interface UsageSummary {
  models: Record<string, ModelUsage>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  rateLimit?: RateLimitInfo;
  window: { start: number; end: number };
}

interface FileCacheEntry {
  usage: Record<string, ModelUsage>;
  rateLimit?: RateLimitInfo;
  mtimeMs: number;
}

const fileCache = new Map<string, FileCacheEntry>();

const CHUNK_SIZE = 256 * 1024;

/**
 * Scan a single JSONL file for assistant usage and rate_limit_event entries.
 * Streams in chunks to avoid loading large files into memory.
 */
async function scanFile(filePath: string): Promise<FileCacheEntry | null> {
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await open(filePath, "r");
    const stats = await fh.stat();
    const { mtimeMs, size } = stats;

    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached;

    if (size === 0) return null;

    const usage: Record<string, ModelUsage> = {};
    let rateLimit: RateLimitInfo | undefined;

    let offset = 0;
    let leftover = "";

    while (offset < size) {
      const readSize = Math.min(CHUNK_SIZE, size - offset);
      const buf = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await fh.read(buf, 0, readSize, offset);
      if (bytesRead === 0) break;

      const chunk = leftover + buf.toString("utf8", 0, bytesRead);
      const lines = chunk.split("\n");

      // Last element may be incomplete — save as leftover
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;

        // Fast filter: only parse lines with usage or rate_limit
        if (!line.includes('"usage"') && !line.includes('"rate_limit_event"')) {
          continue;
        }

        try {
          const entry = JSON.parse(line);

          if (entry.type === "assistant" && entry.message?.usage) {
            const model: string = entry.message.model || "unknown";
            // Skip synthetic/internal entries
            if (model.startsWith("<")) continue;
            const u = entry.message.usage;
            if (!usage[model]) {
              usage[model] = {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                requestCount: 0,
              };
            }
            const m = usage[model];
            m.inputTokens += u.input_tokens || 0;
            m.outputTokens += u.output_tokens || 0;
            m.cacheReadTokens += u.cache_read_input_tokens || 0;
            m.cacheWriteTokens += u.cache_creation_input_tokens || 0;
            m.requestCount += 1;
          }

          // Forward-compatible: capture rate_limit_event if present
          if (entry.type === "rate_limit_event" && entry.rate_limit_info) {
            const info = entry.rate_limit_info;
            rateLimit = {
              status: info.status,
              utilization: info.utilization,
              resetsAt: info.resetsAt,
              type: info.rateLimitType,
            };
          }
        } catch {
          // Malformed line — skip
        }
      }

      offset += bytesRead;
    }

    // Process leftover
    if (leftover && (leftover.includes('"usage"') || leftover.includes('"rate_limit_event"'))) {
      try {
        const entry = JSON.parse(leftover);
        if (entry.type === "assistant" && entry.message?.usage) {
          const model: string = entry.message.model || "unknown";
          if (!model.startsWith("<")) {
            const u = entry.message.usage;
            if (!usage[model]) {
              usage[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 0 };
            }
            const m = usage[model];
            m.inputTokens += u.input_tokens || 0;
            m.outputTokens += u.output_tokens || 0;
            m.cacheReadTokens += u.cache_read_input_tokens || 0;
            m.cacheWriteTokens += u.cache_creation_input_tokens || 0;
            m.requestCount += 1;
          }
        }
      } catch {
        // skip
      }
    }

    const result: FileCacheEntry = { usage, rateLimit, mtimeMs };
    fileCache.set(filePath, result);
    return result;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Scan all JSONL files across all project directories.
 * Only considers files modified within the given window (default 7 days).
 */
export async function getUsageSummary(days = 7): Promise<UsageSummary> {
  const windowEnd = Date.now();
  const windowStart = windowEnd - days * 24 * 60 * 60 * 1000;

  const base = projectsDir();
  const models: Record<string, ModelUsage> = {};
  let latestRateLimit: RateLimitInfo | undefined;

  // Collect all JSONL files across project directories
  const scanPromises: Promise<FileCacheEntry | null>[] = [];
  const seenFiles = new Set<string>();

  try {
    const projectDirs = await opendir(base);
    for await (const projectEntry of projectDirs) {
      if (!projectEntry.isDirectory()) continue;
      const projectPath = join(base, projectEntry.name);

      try {
        const sessionDir = await opendir(projectPath);
        for await (const sessionEntry of sessionDir) {
          if (!sessionEntry.name.endsWith(".jsonl")) continue;
          const filePath = join(projectPath, sessionEntry.name);

          // Only scan files modified within the window
          try {
            const s = await stat(filePath);
            if (s.mtimeMs < windowStart) continue;
          } catch {
            continue;
          }

          seenFiles.add(filePath);
          scanPromises.push(scanFile(filePath));
        }
      } catch {
        // Can't read project dir — skip
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist
  }

  const results = await Promise.all(scanPromises);

  for (const entry of results) {
    if (!entry) continue;

    for (const [model, usage] of Object.entries(entry.usage)) {
      if (!models[model]) {
        models[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 0 };
      }
      const m = models[model];
      m.inputTokens += usage.inputTokens;
      m.outputTokens += usage.outputTokens;
      m.cacheReadTokens += usage.cacheReadTokens;
      m.cacheWriteTokens += usage.cacheWriteTokens;
      m.requestCount += usage.requestCount;
    }

    if (entry.rateLimit) {
      latestRateLimit = entry.rateLimit;
    }
  }

  // Prune cache entries for files no longer in scope
  for (const key of fileCache.keys()) {
    if (!seenFiles.has(key)) fileCache.delete(key);
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalRequests = 0;
  for (const m of Object.values(models)) {
    totalInputTokens += m.inputTokens;
    totalOutputTokens += m.outputTokens;
    totalRequests += m.requestCount;
  }

  return {
    models,
    totalInputTokens,
    totalOutputTokens,
    totalRequests,
    rateLimit: latestRateLimit,
    window: { start: windowStart, end: windowEnd },
  };
}
