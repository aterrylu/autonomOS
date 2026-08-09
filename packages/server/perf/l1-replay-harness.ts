// L1 replay harness — measures the RECONNECT-REPLAY path of the real terminal
// route (`routes/terminal.ts`): the scrollback a client receives when its WS
// (re)connects. This is the agent-SWITCH cost — every dashboard switch tears
// down the pane's WS and reconnects, replaying the whole buffer.
//
// Unlike the live-burst harness (l1-transport-harness.ts), the burst here is
// emitted BEFORE any client connects, so it lands only in the server-side
// outputBuffer. The measurement starts at WS connect.
//
// What it proves:
//   • frames  — how many WS frames the replay becomes on the wire. On main
//     this is one frame per stored PTY chunk (~19k/MB); replay coalescing
//     should collapse it to ceil(bytes / AUTONOMOS_WS_REPLAY_BYTES).
//   • drainMs — WS open → sentinel (the buffer's last chunk) at the client.
//
// Run:  tsx perf/l1-replay-harness.ts                                (default: ON)
//       AUTONOMOS_WS_REPLAY_COALESCE=0 tsx perf/l1-replay-harness.ts (off == old main)
//       MB=2 tsx perf/l1-replay-harness.ts                           (bigger scrollback)

import type { UUID } from "@autonomos/core";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { _registerSyntheticAttachment } from "../src/agents/runtime.js";
import { FakePty } from "../src/perf/fake-pty.js";
import {
  buildBurst,
  burstBytes,
  DEFAULT_BURST,
} from "../src/perf/ink-burst.js";
import { terminalRouter } from "../src/routes/terminal.js";

const SENTINEL_MARK = "__AUTONOMOS_PERF_SENTINEL__";
const MB = Number(process.env.MB ?? 0) || undefined;

async function main() {
  const sessionId = "00000000-0000-0000-0000-0000000000fe";
  const pty = new FakePty();

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));

  _registerSyntheticAttachment(sessionId as UUID, pty.asIPty());

  // Seed the scrollback BEFORE any client exists — replay-only measurement.
  const burst = buildBurst(
    MB
      ? { ...DEFAULT_BURST, totalBytes: Math.round(MB * 1024 * 1024) }
      : DEFAULT_BURST,
  );
  const totalBytes = burstBytes(burst);
  pty.emitBurst(burst);

  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;

  // ── Connect ONE client; measure the replay it receives ───────────────
  let frames = 0;
  let bytes = 0;
  let sawSentinel = false;
  let resolveSentinel!: () => void;
  const sentinel = new Promise<void>((res) => (resolveSentinel = res));

  const t0 = performance.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${sessionId}`);
  ws.addEventListener("message", (ev: MessageEvent) => {
    const text = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
    frames++;
    bytes += Buffer.byteLength(text);
    if (!sawSentinel && text.includes(SENTINEL_MARK)) {
      sawSentinel = true;
      resolveSentinel();
    }
  });

  await sentinel;
  const drainMs = performance.now() - t0;

  ws.close();
  await new Promise<void>((r) => server.close(() => r()));

  const flag = process.env.AUTONOMOS_WS_REPLAY_COALESCE ?? "(unset → default ON)";
  const summary = {
    config: {
      replayCoalesceFlag: flag,
      bufferedChunks: burst.length,
      payloadKB: +(totalBytes / 1024).toFixed(1),
    },
    replay: {
      frames,
      bytesReceived: bytes,
      chunksPerFrame: +(burst.length / (frames || 1)).toFixed(2),
      drainMs: +drainMs.toFixed(1),
      throughputMBs: +(totalBytes / 1024 / 1024 / (drainMs / 1000)).toFixed(1),
    },
  };

  console.log("\n=== L1 REPLAY HARNESS ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\nHEADLINE: ${burst.length} buffered chunks → ${frames} WS frames on reconnect ` +
      `(${summary.replay.chunksPerFrame} chunks/frame), drain ${summary.replay.drainMs}ms`,
  );

  // Integrity guards: full replay must arrive, byte-complete.
  if (!sawSentinel) {
    console.error("✗ INTEGRITY: sentinel never arrived");
    process.exit(1);
  }
  if (bytes !== totalBytes) {
    console.error(
      `✗ INTEGRITY: byte mismatch — sent ${totalBytes}, received ${bytes}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("harness failed:", err);
  process.exit(1);
});
