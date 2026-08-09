---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Instant agent switching: keep-alive terminal cache + coalesced reconnect-replay (ADR-071). Switching agents no longer re-renders the terminal from scratch — the xterm instance and its WebSocket survive pane teardown (switch-back: 0 frames re-streamed, ~44ms, was ~19k+ frames / seconds on a slow network), and cold reconnects replay the scrollback in ~16 large frames instead of one per PTY chunk. Reconnects also no longer duplicate scrollback history.
