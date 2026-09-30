import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import WebSocket from "ws";
import {
  _resetAgentCredentialsForTesting,
  mintAgentToken,
} from "../agentCredentials.js";
import { MAX_GATEWAY_FRAME_BYTES } from "../gateway/deliveryTimings.js";
import { gatewayRouter, limitGatewayFrames } from "../routes/gateway.js";
import { waitUntil } from "./helpers/wait.js";

/**
 * Follow-ups from the review of V6 (security audit), ADR-127:
 *  1. A frame size limit on /ws/gateway. @hono/node-ws builds its
 *     WebSocketServer with ws's 100 MiB default and no way to pass options, so
 *     any agent could make the server buffer and parse 100 MiB per frame.
 *  2. A per-socket budget on malformed-frame warnings, so a stream of bad
 *     frames can't flood the rotating log (each line is already bounded).
 *  3. Log fields that came straight from a client are quoted and capped, so a
 *     session id or destination with a newline can't forge a log line.
 *  4. The channel server refuses an oversized send locally, with a clear
 *     message, instead of the gateway closing its socket and the sender
 *     waiting out its whole deadline.
 */

process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-gwl-cfg-"));

const DIR = mkdtempSync("/tmp/aos-gwl-");
const SOCK = join(DIR, "g.sock");
const URL = `ws+unix://${SOCK}:/ws/gateway`;
let server: Server;

/** Connect, send `frames`, resolve with the close code (or null if still open
 *  after `settleMs`). */
function exchange(
  frames: (string | Buffer)[],
  settleMs = 400,
): Promise<number | null> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    let code: number | null = null;
    ws.on("close", (c) => {
      code = c;
    });
    ws.on("error", () => {});
    ws.on("open", () => {
      for (const f of frames) ws.send(f);
      setTimeout(() => {
        const out = code;
        ws.close();
        res(out);
      }, settleMs);
    });
    ws.on("unexpected-response", () => rej(new Error("upgrade refused")));
  });
}

/** Capture console.warn/error lines for the duration of `fn`. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = w;
    console.error = e;
  }
  return lines;
}

before(async () => {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({
    app,
  });
  limitGatewayFrames(wss);
  app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));
  server = createAdaptorServer({ fetch: app.fetch }) as Server;
  injectWebSocket(server);
  await new Promise<void>((r) => server.listen(SOCK, r));
});

after(() => {
  _resetAgentCredentialsForTesting();
  server?.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("gateway frame size limit", () => {
  it("is well below ws's 100 MiB default", () => {
    assert.ok(MAX_GATEWAY_FRAME_BYTES <= 4 * 1024 * 1024);
    assert.ok(
      MAX_GATEWAY_FRAME_BYTES >= 256 * 1024,
      "room for a long agent message",
    );
  });

  it("closes a socket that sends a frame over the limit (1009), and keeps serving", async () => {
    const big = Buffer.alloc(MAX_GATEWAY_FRAME_BYTES + 1, 0x61);
    assert.equal(await exchange([big]), 1009);
    // The gateway still accepts a valid register afterwards: a registered
    // client stays open (a rejected one is closed 1008).
    const token = mintAgentToken("sess-after-big");
    const code = await exchange([
      JSON.stringify({
        type: "register",
        sessionId: "sess-after-big",
        agentToken: token,
      }),
    ]);
    assert.equal(
      code,
      null,
      "a valid register after an oversized frame must stay open",
    );
  });

  it("accepts a frame just under the limit", async () => {
    // A large but in-limit frame is parsed (and rejected as malformed, which
    // proves it reached the handler rather than being cut off by the limit).
    const payload = JSON.stringify({
      type: "x".repeat(MAX_GATEWAY_FRAME_BYTES - 100),
    });
    const lines = await captureWarnings(async () => {
      assert.equal(
        await exchange([payload]),
        null,
        "must not be closed for size",
      );
    });
    assert.ok(
      lines.some((l) => l.includes("unknown message type")),
      lines.join("\n"),
    );
  });
});

describe("malformed-frame warnings are rate-limited per socket", () => {
  it("logs a bounded number of lines for a flood, then a suppressed-count summary", async () => {
    const lines = await captureWarnings(async () => {
      await exchange(
        Array.from({ length: 200 }, () => "null"),
        600,
      );
      // the summary is written when the socket closes
      await new Promise((r) => setTimeout(r, 200));
    });
    const dropped = lines.filter((l) =>
      l.includes("dropped a malformed frame"),
    );
    assert.ok(dropped.length > 0, "the first bad frames are still reported");
    assert.ok(
      dropped.length <= 10,
      `${dropped.length} lines for 200 bad frames`,
    );
    assert.ok(
      lines.some((l) => /suppressed \d+ more malformed frame/.test(l)),
      `no summary in:\n${lines.join("\n")}`,
    );
  });
});

describe("client-supplied log fields are quoted and capped", () => {
  it("a session id with a newline can't forge a log line on a rejected register", async () => {
    const lines = await captureWarnings(async () => {
      await exchange([
        JSON.stringify({
          type: "register",
          sessionId: "ab\n[gateway] FORGED LINE",
          agentToken: "wrong",
        }),
      ]);
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("rejected register"), joined);
    assert.ok(
      !joined.includes("\n[gateway] FORGED"),
      "a raw newline reached the log",
    );
  });
});

describe("the channel server refuses an oversized send itself", () => {
  const ARTIFACT = resolve(import.meta.dirname, "../channel-server/dist.mjs");

  it("answers with a clear error instead of sending a frame the gateway will cut", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aos-gwl-cs-"));
    const child = spawn(process.execPath, [ARTIFACT], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        AUTONOMOS_SERVER_URL: "ws+unix:///nonexistent-gwl.sock:/ws/gateway",
        AUTONOMOS_SESSION_ID: "gwl-test",
        AUTONOMOS_AGENT_NAME: "gwl-test",
        AUTONOMOS_CONFIG_DIR: cwd,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    const rpc = (id: number, method: string, params: unknown) =>
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    await waitUntil(() => out.includes('"id":1'), "initialize reply", 15_000);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    rpc(2, "tools/call", {
      name: "send",
      arguments: {
        to: "agent://x",
        message: "y".repeat(MAX_GATEWAY_FRAME_BYTES),
      },
    });
    try {
      await waitUntil(() => out.includes('"id":2'), "send reply", 15_000);
      const reply = out.split("\n").find((l) => l.includes('"id":2')) ?? "";
      assert.match(reply, /too large/i);
      assert.match(reply, /"isError":true/);
    } finally {
      child.kill("SIGKILL");
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
