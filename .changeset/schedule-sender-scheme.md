---
"@autonomos/server": patch
---

feat(gateway): scheduled prompts identify their schedule — `schedule://<name>` (ADR-092)

- A scheduled prompt now arrives as `[Schedule <name> → you via schedule://<name>]` instead of the phantom `agent://Scheduler`, so the receiving agent knows which schedule fired.
- Replying to `schedule://<name>` gets actionable guidance (schedules have no inbox; `get_schedule("<name>")`/`update_schedule`/`delete_schedule` are named with the name pre-filled) instead of "unknown scheme" or a hunt through list_agents.
- BASE_CONTEXT teaches the scheme to new spawns; the #330 `agent://Scheduler` courtesy reply stays one release for old transcripts. No name reservation needed — schedules and agents live in different URI namespaces.
