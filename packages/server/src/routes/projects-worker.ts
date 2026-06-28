/**
 * Worker thread for the expensive part of GET /api/projects.
 *
 * Background: `listSessions()` from the Claude Agent SDK walks every JSONL
 * file under ~/.claude/projects/** (thousands of files, hundreds of MB) and
 * does enough synchronous parse work to block the Node event loop for ~10s
 * on a well-used machine. That blocks every other request, including the
 * WebSocket pipeline that streams terminal echoes — see
 * docs/typing-lag-investigation.md.
 *
 * Running the call in a worker keeps the main thread free so terminal I/O
 * stays responsive even during a project-list refresh.
 */

import { parentPort } from "node:worker_threads";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

if (!parentPort) {
  throw new Error("projects-worker must be run as a worker_thread");
}

parentPort.on("message", async () => {
  try {
    const sessions = await listSessions();
    parentPort!.postMessage({ ok: true, sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ ok: false, error: message });
  }
});
