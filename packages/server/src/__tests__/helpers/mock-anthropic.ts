/**
 * Mock Anthropic backend — fakes ONLY the `/v1/messages` endpoint so the
 * REAL `claude` binary can be driven through autonomOS's real provider / PTY /
 * hook-relay path at zero API cost.
 *
 * We do NOT fake the claude binary. The provider's `buildEnv()` spreads the
 * server's `process.env` into every spawned session (providers/shared.ts
 * buildBaseEnv), so setting `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` on
 * the test server's environment (see helpers/test-server.ts) makes a real
 * `claude` invocation stream against our SSE instead of Anthropic.
 *
 * Endpoints:
 *   - POST /v1/messages           → SSE stream (text end_turn, or tool_use turn)
 *   - POST /v1/messages/count_tokens → { input_tokens: N }
 *   - everything else / HEAD      → {}
 *
 * The messages route is matched on `url.includes("/v1/messages") &&
 * !url.includes("count_tokens")` because claude calls
 * `POST /v1/messages?beta=true`.
 *
 * Validated against real claude 2.1.168.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A single request the mock observed — used by tests to assert turn count. */
export interface RecordedRequest {
  method: string;
  url: string;
  /** Parsed JSON body (best-effort; undefined if not JSON). */
  body: unknown;
}

export interface MockAnthropic {
  /** Base URL to feed to ANTHROPIC_BASE_URL, e.g. http://127.0.0.1:54321 */
  url: string;
  /** Every request the mock has received, in order. */
  requests: RecordedRequest[];
  /** Stop the server and release the port. */
  close: () => Promise<void>;
}

export type MockMode = "text" | "tool_use";

export interface MockOptions {
  /**
   * "text"     — every turn returns a plain-text end_turn (default).
   * "tool_use" — the FIRST turn emits a tool_use block (so PreToolUse/
   *              PostToolUse fire on the real agent), and every subsequent
   *              turn returns a plain-text end_turn so the run terminates.
   */
  mode?: MockMode;
  /** Text emitted for plain-text turns. Defaults to "Done.". */
  text?: string;
  /** Tool name to emit in tool_use mode. Defaults to "Read". */
  toolName?: string;
  /** Tool input object to emit in tool_use mode. Defaults to a noop read. */
  toolInput?: Record<string, unknown>;
}

/** Server-Sent Events writer for the `/v1/messages` streaming format. */
function writeSse(
  res: import("node:http").ServerResponse,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Emit a complete plain-text end_turn message stream. */
function streamText(
  res: import("node:http").ServerResponse,
  text: string,
): void {
  const msg = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "claude-mock",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  writeSse(res, "message_start", { type: "message_start", message: msg });
  writeSse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeSse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

/** Emit a tool_use turn: claude will run the tool, fire PreToolUse/PostToolUse,
 *  then send the tool_result back as a new turn. */
function streamToolUse(
  res: import("node:http").ServerResponse,
  toolName: string,
  toolInput: Record<string, unknown>,
): void {
  const msg = {
    id: "msg_mock_tool",
    type: "message",
    role: "assistant",
    model: "claude-mock",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  writeSse(res, "message_start", { type: "message_start", message: msg });
  writeSse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "toolu_mock",
      name: toolName,
      input: {},
    },
  });
  // input streamed as partial JSON per the real API contract
  writeSse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify(toolInput),
    },
  });
  writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Start the mock backend on an ephemeral port (port 0). Resolves once it is
 * listening. Caller MUST `await close()` to release the port.
 */
export function startMockAnthropic(
  options: MockOptions = {},
): Promise<MockAnthropic> {
  const mode = options.mode ?? "text";
  const text = options.text ?? "Done.";
  const toolName = options.toolName ?? "Read";
  const toolInput = options.toolInput ?? { file_path: "/dev/null" };

  const requests: RecordedRequest[] = [];
  // In tool_use mode we emit the tool_use block exactly once (the first
  // /v1/messages turn); later turns fall back to plain text so the run ends.
  let toolTurnEmitted = false;

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    void readBody(req).then((body) => {
      requests.push({ method, url, body });

      // count_tokens — claude probes this; return a small number.
      if (url.includes("count_tokens")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }

      // The streaming messages endpoint. claude calls POST /v1/messages?beta=true.
      if (method === "POST" && url.includes("/v1/messages")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mode === "tool_use" && !toolTurnEmitted) {
          toolTurnEmitted = true;
          streamToolUse(res, toolName, toolInput);
        } else {
          streamText(res, text);
        }
        return;
      }

      // Everything else (HEAD probes, model lookups, etc.) — empty object.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });

  return new Promise((resolveFn) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolveFn({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
