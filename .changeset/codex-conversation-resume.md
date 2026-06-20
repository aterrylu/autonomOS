---
"@autonomos/server": minor
"@autonomos/core": minor
---

Codex agents now RESUME their prior conversation across a server/daemon restart, instead of forking a fresh empty thread and losing all memory (A5). The app-server thread id is captured at spawn and persisted on the agent record (`providerThreadId`); on resume the agent spawns as `codex resume <threadId> --remote` to reattach the persisted rollout (full history + memory). If the rollout is missing/pruned, the resume crash is caught and the agent auto-falls-back to a fresh thread (no crash-loop) with a dashboard notification, rather than dying every boot.
