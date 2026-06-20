---
"@autonomos/server": minor
---

Codex agents now show LIVE busy/idle status in the dashboard instead of a flat "running" (A3). Codex has no hook relay, so its status is sourced from the app-server daemon's event stream: the per-agent control client connects eagerly at spawn, reads ground-truth status (thread/status/changed pushes + a periodic thread/read reconciler), and feeds it into the same in-memory status map Claude Code/Gemini use — so no dashboard changes were needed. A persistently-unreachable daemon surfaces a dashboard notification rather than silently leaving status stale.
