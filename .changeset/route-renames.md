---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

feat(server): route renames behind one-release compat aliases (API-consolidation PR C, ADR-084)

- `/auth` → `/api/auth`; `/api/scheduler/{status,settings}` → `/api/schedules/{status,settings}`; hook READS → `/api/agent-status` + `/api/notifications` (ingest untouched).
- Old paths keep serving through the same handler functions for one release, logging a deprecation pointer once per mount; `status`/`settings` are reserved as schedule names.
