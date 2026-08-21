# Terminal performance harness

Falsifiable, ablation-style benchmarks for the terminal-over-web data path. Every
optimization is **flag-gated** so we A/B the *same build* (fix off vs on) instead
of diffing branches — the only variable that changes is the fix under test.

## Integrity principle

A synthetic load only proves something if it reproduces the real symptom on
unmodified `main`. The generator (`ink-burst.ts`) is tuned to fan a ~1 MB burst
into ~19k tiny PTY chunks (Ink-style). If a baseline run ever shows no stress,
make the generator more aggressive before trusting any "after" number.

## L1 — transport layer (Node, no browser)

Drives the **real** `routes/terminal.ts` transport with a deterministic burst
through a `FakePty`, and counts WebSocket frames + server event-loop health.

```bash
# from packages/server/
AUTONOMOS_WS_COALESCE=0 bun run perf:l1      # baseline (== main)
AUTONOMOS_WS_COALESCE=1 bun run perf:l1      # with #1 frame coalescing
PANES=4 AUTONOMOS_WS_COALESCE=1 bun run perf:l1   # 4-pane scenario
```

Knobs: `AUTONOMOS_WS_COALESCE_MS` (flush window, default 5), `AUTONOMOS_WS_COALESCE_BYTES`
(size flush, default 16384), `AUTONOMOS_WS_COALESCE_LEADING=1` (restore the
pre-ADR-086 leading-edge flush — ablation only; it tears unsynchronized TUI
repaints), `PANES` (concurrent clients).

### Measured ablation (1.09 MB burst → 18,829 PTY chunks)

| Config | WS frames / pane | Drain | Server loop-stall (max) |
|---|---|---|---|
| baseline, 1 pane | 18,829 | 64 ms | 11.1 ms |
| **#1 on, 1 pane** | **33** (570× fewer) | **10.7 ms** | **2.0 ms** |
| baseline, 4 panes | 18,829 | 177 ms | 31.8 ms |
| **#1 on, 4 panes** | **33** | **23 ms** | 6.6 ms |

Flag-off is exactly 18,829 frames → the gate is byte-identical to `main`.

> **Caveat:** 570× is an upper bound — real Claude Code chunks are larger than
> the generator's ~48-byte mean (the OS PTY coalesces reads), so the real-world
> multiplier is smaller but still large. L1 proves the mechanism; the browser
> layer (L2) + a real-session capture calibrate the absolute number.

## L1-replay — reconnect replay (agent-switch cost)

Same rig, but the burst is emitted BEFORE the client connects, so it lands only
in the server-side scrollback buffer — the measurement is the replay a
(re)connecting client receives, i.e. what every agent switch used to pay.

```bash
# from packages/server/
bun run perf:l1-replay                                  # replay coalescing ON (default)
AUTONOMOS_WS_REPLAY_COALESCE=0 bun run perf:l1-replay   # per-chunk replay (== old main)
```

### Measured ablation (1.09 MB buffered scrollback)

| Config | Replay frames | Drain (loopback) |
|---|---|---|
| per-chunk (old main) | 18,829 | 78 ms |
| **replay coalescing** | **9-16** | **18 ms** |

## L2 — real-dashboard render + agent-switch (Playwright)

Real dashboard + real (isolated) server, headed so the WebGL path is genuine.
`run-l2.sh` boots both on their own ports + config dir and runs the specs:

```bash
# from packages/server/
./perf/run-l2.sh                    # all specs
./perf/run-l2.sh terminal-switch    # the agent-switch benchmark
AUTONOMOS_WS_REPLAY_COALESCE=0 ./perf/run-l2.sh terminal-switch   # ablate replay fix
```

Specs: `terminal-burst` (live-burst render cost: frames, long-task blocking,
dropped rAF frames), `terminal-profile` (CDP CPU profile bucketed by source),
`terminal-switch` (THE user complaint: open a 1MB-scrollback agent, switch
away, switch back — WS reconnects, frames/bytes re-streamed, click→settled,
plus a non-blank pixel integrity guard).

### Measured agent-switch matrix (1MB scrollback, loopback)

| Config | WS reconnects | frames | KB re-streamed | settled |
|---|---|---|---|---|
| old main | 1 | 37,075 | 1024 | 965 ms |
| replay coalescing only | 1 | 16 | 1024 | 412 ms |
| **+ keep-alive cache (ADR-069)** | **0** | **0** | **0** | **44 ms** |

Loopback understates the baseline pain: 37k frames over a real network is the
multi-second "text rushing in" the fix removes. The keep-alive row has no
network component at all, so throttling cannot degrade it.

`PERF_THROTTLE=1` re-runs the switch spec on a CDP-throttled link (Slow-3G-ish,
150ms RTT / 750kbps, applied after the app loads). Measured: a COLD open of the
1MB-scrollback agent takes **85s** to fully drain even with coalescing — while
the keep-alive **switch-back on the same throttled link settles in ~320ms with
0 frames re-streamed**. That 267× gap is the whole point: no amount of replay
optimization makes re-streaming acceptable on a slow network; only not
re-streaming does.
