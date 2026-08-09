---
"@autonomos/server": patch
"@autonomos/core": patch
---

refactor(api): conventions ADR + dead-surface removal (API-consolidation PR 1)

- Removed unreachable/caller-less surface: the `/ws/gateway` `dashboard_connect` client type + per-message dashboard fan-out (unreachable since the socket move), `GET /api/hooks/:sessionId/status` + `GET /api/hooks/:sessionId/notifications` (bulk reads cover them), `PATCH /api/agents/:id` (no callers), and the vestigial `GatewayMessage.platform`/`platformMessageId` fields.
- Hook state (status entry + notifications) is now reclaimed when an agent is DELETED, so `GET /api/hooks` no longer returns ids that resolve to nothing; KILL still keeps history.
- Deleting an agent now also revokes its per-agent token (at the store's delete chokepoint), so a straggler hook event from the dying process can no longer re-create the status entry the delete just reclaimed.
- Scheduled prompts now arrive from "Scheduler" instead of the sliced pseudo-UUID "Agent schedule".
- The API-conventions ADR documents the target error envelope, status codes, validation source, resolver, path rules, WS envelope, and the `/api/system/version` seam for the remaining consolidation slices.
