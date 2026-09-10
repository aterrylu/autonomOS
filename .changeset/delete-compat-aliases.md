---
"@autonomos/server": patch
---

feat(server)!: remove the one-release route compat aliases (executes ADR-084/ADR-092's recorded plan)

- Deleted: `POST /auth`, `GET /api/hooks` + `/api/hooks/notifications` + `POST /api/hooks/:id/read` (read aliases; ingest untouched), `/api/scheduler/{status,settings}` — all now 404 with the standard envelope. Use `/api/auth`, `/api/agent-status`, `/api/notifications`, `/api/schedules/{status,settings}`.
- Also removed the `agent://Scheduler` reply courtesy and the legacy `"scheduler"` sender mapping (superseded by `schedule://<name>`, ADR-092).
- Prod-log evidence before deletion: zero callers of any old route across all server boots in the last 2-3 weeks on both production hosts (the only hits ever logged were the release engineer's own v0.6.0 validation probes and one stale pre-rename dashboard tab at each host's upgrade moment).
