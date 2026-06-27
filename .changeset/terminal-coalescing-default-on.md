---
"@autonomos/server": patch
---

Enable terminal WebSocket frame coalescing by default and make it leading-edge. Coalescing (added previously behind `AUTONOMOS_WS_COALESCE=1`) eliminates burst-induced dropped frames (measured 12/31/65 → 0 at 1/4/12 MB on a real GPU) and cuts frame count ~570× over the network/multi-pane — but a pure trailing window added up to 8 ms to interactive echo. The coalescer is now **leading-edge**: the first chunk after an idle gap flushes immediately (zero added latency for typing and slow output), and only a genuine burst — chunks arriving faster than the window — coalesces. This makes it strictly ≥ the historical per-chunk behavior on every axis, so it's now ON by default. Set `AUTONOMOS_WS_COALESCE=0` to restore the exact per-chunk send as an escape hatch.
