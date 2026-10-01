---
"@autonomos/server": patch
---

The server no longer dies when its stdout reader goes away (for example `autonomos … | tee` interrupted with Ctrl-C). Shutdown now always finishes stopping agents: previously a busy Codex agent's daemon, and the command it was running, could be left behind.
