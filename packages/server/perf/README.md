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

Knobs: `AUTONOMOS_WS_COALESCE_MS` (flush window, default 8), `AUTONOMOS_WS_COALESCE_BYTES`
(size flush, default 16384), `PANES` (concurrent clients).

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

## L2/L3 — perceived render + responsiveness (Playwright)

_(in progress)_ Real dashboard + real server, headed for WebGL numbers:
time-to-sentinel in the xterm buffer, total-blocking-time via
`PerformanceObserver('longtask')`, dropped frames, keystroke echo latency under
sustained flood.
