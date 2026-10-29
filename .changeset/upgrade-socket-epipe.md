---
"@autonomos/server": patch
---

The server no longer crashes when a WebSocket client disconnects in the middle of connecting, for example when several agents are killed in quick succession while the dashboard is open. Previously the whole server exited and took every running agent with it.
