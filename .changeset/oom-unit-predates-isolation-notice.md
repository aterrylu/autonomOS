---
"@autonomos/server": patch
---

A Linux install updated from v0.7.0 keeps its old service unit (v0.7.0's own updater performs the update), so one agent running out of memory can still stop the server and every agent. The server now says so once at boot, in the bell and the log, with a one-line systemd drop-in command for its own unit that turns per-agent isolation on without changing anything else in the unit.
