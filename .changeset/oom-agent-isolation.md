---
"@autonomos/cli": patch
"@autonomos/server": patch
---

fix(server): when an agent's process runs out of memory on Linux, only that agent is affected. The server and the other agents keep running, and the bell names the agent; it's resumed once in the same conversation. The service unit gains `OOMPolicy=continue` and `Delegate=yes` (applied on your next update). Each agent gets its own cgroup, and its processes are the kernel's first pick instead of the server.
