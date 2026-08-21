// Regression test for the coalescing-ON trailing-output drop on PTY exit:
// the onExit handler must flush each client's pending (coalesced) buffer while
// the socket is still OPEN, BEFORE close() — otherwise the final pre-exit
// output is silently lost (close() resolves async, so a later flush sends on a
// dead socket). Mirrors the L1 harness wiring (real terminal route + FakePty).
//
// Env is set before a DYNAMIC import because DEFAULT_COALESCE is frozen at
// module load. node's test runner isolates each file in its own process, so
// this doesn't affect the other terminal tests.

import assert from "node:assert";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

process.env.AUTONOMOS_WS_COALESCE = "1";
// Very long window so the timer never auto-flushes during the test — the only
// thing that can deliver the pending chunk is the onExit flush we're testing.
process.env.AUTONOMOS_WS_COALESCE_MS = "100000";

const { terminalRouter } = await import("../routes/terminal.js");
const { _registerSyntheticAttachment } = await import("../agents/runtime.js");
const { FakePty } = await import("../perf/fake-pty.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("coalesced trailing output is flushed on PTY exit (not dropped)", async () => {
  const sessionId = "00000000-0000-4000-8000-00000000ex01";
  const pty = new FakePty();
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
  _registerSyntheticAttachment(
    sessionId as `${string}-${string}-${string}-${string}-${string}`,
    pty.asIPty(),
  );

  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;

  let received = "";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${sessionId}`);
  ws.addEventListener("message", (ev: MessageEvent) => {
    received += typeof ev.data === "string" ? ev.data : "";
  });
  await new Promise<void>((r) =>
    ws.addEventListener("open", () => r(), { once: true }),
  );
  // Wait until the route's per-connection onData listener is attached
  // (runtime buffer + this client = 2).
  for (let i = 0; i < 100 && pty.listenerCount < 2; i++) await sleep(5);

  // Trailing-edge default: BOTH chunks stay pending inside the huge window —
  // the only thing that can deliver them is the onExit flush under test.
  pty.emit("PRIME\n");
  pty.emit("FINAL_PROMPT$ ");
  await sleep(30);
  assert.equal(received, "", "chunks must still be pending (trailing edge)");

  // PTY exits → onExit must flush the pending tail before closing.
  pty.kill();
  for (let i = 0; i < 100 && !received.includes("FINAL_PROMPT"); i++)
    await sleep(5);

  assert.equal(
    received,
    "PRIME\nFINAL_PROMPT$ ",
    "trailing coalesced output must survive PTY exit",
  );

  await new Promise<void>((r) => server.close(() => r()));
});
