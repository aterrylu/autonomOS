---
"@autonomos/server": patch
---

A Linux install upgraded from v0.7.0 keeps its old service unit (v0.7.0's own upgrader does the update), so per-agent out-of-memory isolation stays off. The server now says so once at boot, in the bell and the log, with the exact `autonomos install-service --force …` command that turns it on.
