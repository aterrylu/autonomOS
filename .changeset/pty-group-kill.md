---
"@autonomos/server": patch
---

Killing, deleting or restarting an agent, or stopping the server, now ends every process in the agent's terminal process group, not just its main process. Gemini agents used to survive this: every "restart all" left the old Gemini processes running, and they lingered after shutdown. A second "restart all" while one is in progress is now refused (409). An agent started while a "restart all" is in progress, and that exits during it, is now marked exited instead of staying "running".
