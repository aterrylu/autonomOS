// L1 transport harness — measures the SERVER → WebSocket framing layer using
// the REAL terminal route (`routes/terminal.ts`), driven by a deterministic
// synthetic burst through a FakePty. No browser, no `claude`.
//
// What it proves:
//   • frames  — how many WS frames the burst becomes on the wire. This is the
//     core "frame fanout" number; coalescing (#1) should collapse it ~10×.
//   • drainMs — wall time from first emit to the sentinel arriving at the
//     client (transport catch-up latency).
//   • loopDelayMaxMs — worst event-loop stall during the burst (server health).
//
// Run:  AUTONOMOS_WS_COALESCE=0 tsx perf/l1-transport-harness.ts
//       AUTONOMOS_WS_COALESCE=1 tsx perf/l1-transport-harness.ts   (after #1)
//       PANES=4 tsx perf/l1-transport-harness.ts                   (multi-pane)

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { _registerSyntheticAttachment } from "../src/agents/runtime.js";
import { FakePty } from "../src/perf/fake-pty.js";
import {
  buildBurst,
  burstBytes,
  DEFAULT_BURST,
  SENTINEL,
} from "../src/perf/ink-burst.js";
import { terminalRouter } from "../src/routes/terminal.js";

const SENTINEL_MARK = "__AUTONOMOS_PERF_SENTINEL__";
const PANES = Number(process.env.PANES ?? 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ClientResult {
  frames: number;
  bytes: number;
  sawSentinel: boolean;
}

async function main() {
  const sessionId = "00000000-0000-0000-0000-0000000000ff";
  const pty = new FakePty();

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));

  // Register the synthetic session BEFORE any client connects.
  _registerSyntheticAttachment(
    sessionId as `${string}-${string}-${string}-${string}-${string}`,
    pty.asIPty(),
  );

  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;

  const burst = buildBurst(DEFAULT_BURST);
  const totalBytes = burstBytes(burst);

  // ── Connect N clients (panes) ────────────────────────────────────────
  const results: ClientResult[] = [];
  const sentinelSeen: Array<() => void> = [];
  const sentinelPromises: Promise<void>[] = [];
  const sockets: WebSocket[] = [];

  for (let i = 0; i < PANES; i++) {
    const r: ClientResult = { frames: 0, bytes: 0, sawSentinel: false };
    results.push(r);
    let resolveSentinel!: () => void;
    sentinelPromises.push(new Promise<void>((res) => (resolveSentinel = res)));
    sentinelSeen.push(resolveSentinel);

    // Node's built-in (undici) WebSocket client — browser-style event API.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${sessionId}`);
    ws.addEventListener("message", (ev: MessageEvent) => {
      const text =
        typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
      r.frames++;
      r.bytes += Buffer.byteLength(text);
      if (!r.sawSentinel && text.includes(SENTINEL_MARK)) {
        r.sawSentinel = true;
        sentinelSeen[i]();
      }
    });
    sockets.push(ws);
    await new Promise<void>((res) =>
      ws.addEventListener("open", () => res(), { once: true }),
    );
  }

  // Wait until every client's server-side onData listener is registered.
  // listeners = 1 (runtime output buffer) + PANES (one per connection).
  const expectedListeners = 1 + PANES;
  for (let i = 0; i < 200 && pty.listenerCount < expectedListeners; i++) {
    await sleep(5);
  }

  // ── Drive the burst, measuring ───────────────────────────────────────
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const t0 = performance.now();

  pty.emitBurst(burst);

  await Promise.all(sentinelPromises);
  const drainMs = performance.now() - t0;
  loop.disable();

  for (const ws of sockets) ws.close();
  await new Promise<void>((r) => server.close(() => r()));

  // ── Report ───────────────────────────────────────────────────────────
  const coalesce = process.env.AUTONOMOS_WS_COALESCE ?? "(unset → baseline)";
  const framesPerPane = results.map((r) => r.frames);
  const totalFrames = framesPerPane.reduce((a, b) => a + b, 0);

  const summary = {
    config: {
      coalesceFlag: coalesce,
      panes: PANES,
      ptyChunks: burst.length,
      payloadKB: +(totalBytes / 1024).toFixed(1),
    },
    transport: {
      framesTotal: totalFrames,
      framesPerPane,
      // The headline ratio: how many PTY chunks collapsed into how many frames.
      chunksPerFrame: +(burst.length / (framesPerPane[0] || 1)).toFixed(2),
      drainMs: +drainMs.toFixed(1),
      throughputMBs: +(totalBytes / 1024 / 1024 / (drainMs / 1000)).toFixed(1),
    },
    serverHealth: {
      loopDelayMaxMs: +(loop.max / 1e6).toFixed(2),
      loopDelayMeanMs: +(loop.mean / 1e6).toFixed(3),
      loopDelayP99Ms: +(loop.percentile(99) / 1e6).toFixed(2),
    },
  };

  console.log("\n=== L1 TRANSPORT HARNESS ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\nHEADLINE: ${burst.length} PTY chunks → ${framesPerPane[0]} WS frames/pane ` +
      `(${summary.transport.chunksPerFrame}× coalesce), drain ${summary.transport.drainMs}ms, ` +
      `loop-stall max ${summary.serverHealth.loopDelayMaxMs}ms`,
  );

  // Integrity guard: every client must have caught up.
  if (results.some((r) => !r.sawSentinel)) {
    console.error("✗ INTEGRITY: a client never received the sentinel");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("harness failed:", err);
  process.exit(1);
});

void SENTINEL; // referenced for clarity; detection uses SENTINEL_MARK substring
