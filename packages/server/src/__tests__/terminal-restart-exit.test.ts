// Regression test for #362's "stale render after Restart" (Terry's live gate):
// a restart is kill → attach under the SAME session id, and the killed PTY's
// exit lands ~1s after the kill, when the restarted pane's socket is already
// bound to the NEW PTY. Exit bookkeeping keyed by session id let that late
// exit close the new viewer with 4010, which the dashboard treats as a final
// session end, so the pane kept the pre-restart output until a remount.
// Mirrors the terminal-exit-flush wiring (real terminal route + FakePty).

import assert from "node:assert";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

const { terminalRouter } = await import("../routes/terminal.js");
const { _registerSyntheticAttachment } = await import("../agents/runtime.js");
const { FakePty } = await import("../perf/fake-pty.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type UUID = `${string}-${string}-${string}-${string}-${string}`;

interface Client {
  ws: WebSocket;
  received: () => string;
  closeCode: () => number | null;
}

async function connect(port: number, sessionId: string): Promise<Client> {
  let received = "";
  let code: number | null = null;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${sessionId}`);
  ws.addEventListener("message", (ev: MessageEvent) => {
    received += typeof ev.data === "string" ? ev.data : "";
  });
  ws.addEventListener("close", (ev: CloseEvent) => {
    code = ev.code;
  });
  await new Promise<void>((r) =>
    ws.addEventListener("open", () => r(), { once: true }),
  );
  return { ws, received: () => received, closeCode: () => code };
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 5) await sleep(5);
}

test("a restarted session's viewer survives the OLD PTY's late exit and streams the new PTY", async () => {
  const sessionId = "00000000-0000-4000-8000-0000000rst01" as UUID;
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;

  try {
    // Before restart: the pane is attached to the original PTY.
    const oldPty = new FakePty();
    _registerSyntheticAttachment(sessionId, oldPty.asIPty());
    const before = await connect(port, sessionId);
    await until(() => oldPty.listenerCount >= 2); // runtime buffer + client

    // Restart: attach spawns a NEW PTY under the same id (the old one is dying
    // but has not exited yet), and the pane's reload connects to it.
    const newPty = new FakePty();
    _registerSyntheticAttachment(sessionId, newPty.asIPty());
    const after = await connect(port, sessionId);
    await until(() => newPty.listenerCount >= 2);

    // The killed PTY's exit finally lands.
    oldPty.kill();
    await until(() => before.closeCode() !== null);
    assert.equal(before.closeCode(), 4010, "the OLD PTY's own viewer ends");
    await sleep(50);
    assert.equal(
      after.closeCode(),
      null,
      "the late exit of the OLD PTY must not close the restarted pane's socket",
    );

    // First new output is visible on the restarted pane without a remount.
    newPty.emit("RESTARTED_PROMPT$ ");
    await until(() => after.received().includes("RESTARTED_PROMPT"));
    assert.ok(
      after.received().includes("RESTARTED_PROMPT"),
      "new PTY output must reach the restarted pane",
    );

    // The NEW PTY got its own exit handler: its real exit still notifies.
    newPty.kill();
    await until(() => after.closeCode() !== null);
    assert.equal(
      after.closeCode(),
      4010,
      "the new PTY's own exit must still end its viewer",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
