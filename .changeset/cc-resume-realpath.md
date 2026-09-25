---
"@autonomos/server": patch
---

Claude Code agents whose working directory is a symlink now resume after a restart instead of crashing. On macOS this includes `/tmp` and every temp directory. Session titles for those agents also show up again. When there is truly nothing to resume, the agent now starts fresh under a new session id instead of crashing with "Session ID … is already in use".
