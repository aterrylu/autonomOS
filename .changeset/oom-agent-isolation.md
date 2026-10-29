---
"@autonomos/cli": patch
"@autonomos/server": patch
---

fix(server): when an agent's process runs out of memory on Linux, only that agent is affected. The server and the other agents keep running, and the bell names the agent; it's resumed once in the same conversation. The service unit gains `OOMPolicy=continue` and `Delegate=yes` (an update from v0.7.0 keeps the old unit: the server then shows a one-line command that adds them, and later updates apply them). Each agent gets its own cgroup, and its processes are the kernel's first pick instead of the server.
