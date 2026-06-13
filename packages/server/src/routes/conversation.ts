import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeParser } from "@autonomos/core";
import { Hono } from "hono";

export const conversationRouter = new Hono();

const parser = new ClaudeCodeParser();

interface ConversationPayload {
  sessionId: string;
  turns: ReturnType<ClaudeCodeParser["groupIntoTurns"]>;
  itemCount: number;
  entryCount: number;
}

/**
 * Parsed-conversation cache, keyed by JSONL file path and invalidated by the
 * file's mtime. The transcript only changes by being appended to, so an mtime
 * mismatch is the precise signal that a re-parse is needed. Without this, every
 * tab reopen re-read + re-parsed the whole JSONL synchronously on the event
 * loop (~180ms for a 32MB transcript, blocking all other JS incl. terminal WS).
 */
const conversationCache = new Map<
  string,
  { mtimeMs: number; payload: ConversationPayload }
>();

/**
 * Find the JSONL file for a Claude Code session.
 * Sessions are stored at ~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl
 */
function findSessionFile(
  sessionId: string,
): { path: string; mtimeMs: number } | null {
  const projectsDir = join(process.env.HOME || "", ".claude", "projects");

  try {
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      const jsonlPath = join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        // statSync, not readFileSync — we only need existence + mtime here.
        // The old readFileSync read the entire (multi-MB) file just to test
        // existence, then the handler read it a second time to parse.
        const st = statSync(jsonlPath);
        return { path: jsonlPath, mtimeMs: st.mtimeMs };
      } catch {
        // Not in this directory
      }
    }
  } catch {
    // projects dir doesn't exist
  }

  return null;
}

/**
 * Read + parse a session transcript, served from the mtime-keyed cache when
 * the file is unchanged. Exported for unit testing the cache behavior.
 */
export function loadConversation(
  sessionId: string,
  filePath: string,
  mtimeMs: number,
): ConversationPayload {
  const cached = conversationCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.payload;
  }

  const content = readFileSync(filePath, "utf-8");
  const entries = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const items = parser.parse(entries);
  const turns = parser.groupIntoTurns(items);
  const payload: ConversationPayload = {
    sessionId,
    turns,
    itemCount: items.length,
    entryCount: entries.length,
  };

  conversationCache.set(filePath, { mtimeMs, payload });
  return payload;
}

/**
 * GET /api/conversation/:sessionId
 *
 * Returns parsed conversation turns for a Claude Code session.
 * The sessionId is the Claude Code session UUID (not our internal PTY session ID).
 */
conversationRouter.get("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");

  // Validate session ID format (UUID)
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    return c.json({ error: "Invalid session ID format" }, 400);
  }

  const found = findSessionFile(sessionId);
  if (!found) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    return c.json(loadConversation(sessionId, found.path, found.mtimeMs));
  } catch {
    return c.json({ error: "Failed to parse session file" }, 500);
  }
});
