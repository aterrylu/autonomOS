import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeParser } from "@autonomos/core";
import { Hono } from "hono";

export const conversationRouter = new Hono();

const parser = new ClaudeCodeParser();

/**
 * Find the JSONL file for a Claude Code session.
 * Sessions are stored at ~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl
 */
function findSessionFile(sessionId: string): string | null {
  const projectsDir = join(process.env.HOME || "", ".claude", "projects");

  try {
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      const jsonlPath = join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        readFileSync(jsonlPath, { flag: "r" });
        return jsonlPath;
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

  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    return c.json({ error: "Session not found" }, 404);
  }

  let entries: unknown[];
  try {
    const content = readFileSync(filePath, "utf-8");
    entries = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return c.json({ error: "Failed to parse session file" }, 500);
  }

  const items = parser.parse(entries);
  const turns = parser.groupIntoTurns(items);

  return c.json({
    sessionId,
    turns,
    itemCount: items.length,
    entryCount: entries.length,
  });
});
