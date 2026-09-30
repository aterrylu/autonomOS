import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { waitUntil } from "./helpers/wait.js";

/**
 * V6 (security audit): ONE malformed /ws/gateway frame crashed the whole
 * server. `JSON.parse("null")` succeeds and `msg.type` then throws; a
 * `register` without `sessionId` throws on `msg.sessionId.slice` in the
 * rejection log line. Both throws escaped the ASYNC onMessage, which Hono's
 * node-ws wraps only in a synchronous try/catch, so they became unhandled
 * rejections and Node exited, taking every PTY with it. Every agent holds the
 * prerequisites (the socket plus a token), including a prompt-injected one.
 *
 * The oracle is the PROCESS: the route runs in a child with no safety net and
 * must still be alive, and still accept a valid register, after every frame.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "helpers", "gateway-fixture-server.ts");

const DIR = mkdtempSync(join(tmpdir(), "aos-gwbad-"));
const SOCKET = join(DIR, "c.sock");
const URL = `ws+unix://${SOCKET}:/ws/gateway`;

let child: ChildProcess;
let exited: { code: number | null; signal: string | null } | null = null;
let stderr = "";
let aliveToken = "";

/** Open a client, send `frames` raw, and resolve with what came back once the
 *  server closes us or `settleMs` passes. */
function exchange(
  frames: string[],
  settleMs = 300,
): Promise<{ received: string[]; closeCode: number | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const received: string[] = [];
    let closeCode: number | null = null;
    ws.on("message", (d) => received.push(d.toString()));
    ws.on("error", reject);
    ws.on("close", (code) => {
      closeCode = code;
    });
    ws.on("open", () => {
      for (const f of frames) ws.send(f);
      setTimeout(() => {
        ws.close();
        resolve({ received, closeCode });
      }, settleMs);
    });
  });
}

// The two PoC frames from the audit, plus the rest of the same class: every
// non-object JSON value, an object with no/odd `type`, and each known type
// with its required fields missing or mistyped.
const MALFORMED: Array<[string, string]> = [
  ["PoC 1: JSON null", "null"],
  ["PoC 2: register without sessionId", '{"type":"register"}'],
  ["a number", "42"],
  ["a string", '"register"'],
  ["an array", '[{"type":"register","sessionId":"x"}]'],
  ["true", "true"],
  ["empty object", "{}"],
  ["non-string type", '{"type":7}'],
  ["register, numeric sessionId", '{"type":"register","sessionId":5}'],
  [
    "register, object agentToken",
    '{"type":"register","sessionId":"s","agentToken":{}}',
  ],
  ["send, nothing else", '{"type":"send"}'],
  [
    "send, non-string to",
    '{"type":"send","to":5,"message":"m","requestId":"r"}',
  ],
  [
    "list_agents_request, object requestId",
    '{"type":"list_agents_request","requestId":{}}',
  ],
  ["invalid JSON", "{nope"],
];

describe("gateway survives malformed frames (V6)", () => {
  before(async () => {
    child = spawn(process.execPath, ["--import", "tsx", FIXTURE, SOCKET], {
      env: {
        ...process.env,
        AUTONOMOS_CONFIG_DIR: mkdtempSync(join(tmpdir(), "aos-gwbad-cfg-")),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    await waitUntil(
      () => out.includes('"ready"'),
      () => `fixture server never became ready. stderr:\n${stderr}`,
      20_000,
    );
    aliveToken = JSON.parse(out.trim().split("\n")[0]).token;
  });

  after(() => {
    if (!exited) child.kill("SIGKILL");
    rmSync(DIR, { recursive: true, force: true });
  });

  for (const [label, frame] of MALFORMED) {
    it(`survives: ${label}`, async () => {
      await exchange([frame]);
      // Give an escaped rejection time to terminate the process.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        exited,
        null,
        `the server process DIED on ${JSON.stringify(frame)}. stderr:\n${stderr}`,
      );
    });
  }

  it("never echoes a register's agentToken into the log", async () => {
    const SECRET = "tok-CANARY-4f1e";
    // Invalid JSON that still carries a token-looking string, and a
    // schema-invalid register carrying one.
    await exchange([
      `{"type":"register","agentToken":"${SECRET}"`,
      `{"type":"register","sessionId":9,"agentToken":"${SECRET}"}`,
    ]);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!stderr.includes(SECRET), "a rejected frame leaked its token");
  });

  it("answers a malformed send that carries a requestId, so the sender isn't left waiting", async () => {
    const { received } = await exchange([
      '{"type":"send","to":5,"message":"m","requestId":"req-bad"}',
    ]);
    const reply = received
      .map((r) => JSON.parse(r))
      .find((m) => m.requestId === "req-bad");
    assert.ok(
      reply,
      `no send_result for the malformed send; got ${JSON.stringify(received)}`,
    );
    assert.equal(reply.type, "send_result");
    assert.equal(reply.success, false);
  });

  it("still accepts a VALID register after all of the above", async () => {
    // A registered client stays open; a rejected one is closed 1008. So "not
    // closed within the settle window" is the accept.
    const { closeCode } = await exchange([
      JSON.stringify({
        type: "register",
        sessionId: "sess-alive",
        agentToken: aliveToken,
      }),
    ]);
    assert.equal(closeCode, null, "a valid register must not be closed");
    assert.equal(exited, null);
  });
});
