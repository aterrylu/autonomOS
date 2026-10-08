---
"@autonomos/server": minor
"@autonomos/dashboard": minor
"@autonomos/core": minor
---

The Org Chart inspector shows the permission mode Claude Code is actually running, taken from its own hooks, next to the mode the agent was set to. When they differ (Shift+Tab inside the session, or Claude Code's own default), it reads "set: manual · running: auto". The value updates at the agent's next prompt or tool call, and survives a page reload.
