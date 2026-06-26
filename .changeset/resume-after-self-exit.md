---
"@autonomos/server": patch
---

Fix agent resume failing with `resumeAgentId "<id>" not found` after an agent calls `self_exit`. The `self_exit` MCP tool issued a hard `DELETE /api/agents/:id`, which `rmSync`'d the agent record off disk — so a later `create_agent({ resumeSessionId })` could not find it (`getAgent()` returned undefined). This was asymmetric with `kill_agent`, which soft-exits via `POST /:id/kill` and keeps the record as `status: "exited"` (resumable). `self_exit` now takes the same soft-exit path, marking the record `exited` with `exitReason: "self_exited"` instead of deleting it, so self-exited agents can be resumed. The `/:id/kill` route gained an optional `{ reason }` body (validated against `ExitReason`, defaulting to `user_killed`) so the exit reason stays honest in the UI/notifications.
