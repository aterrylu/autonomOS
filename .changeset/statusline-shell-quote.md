---
"@autonomos/server": patch
---

fix(security): an unusual install path can't run commands through the agent statusline

The statusline command given to Claude Code quoted autonomOS's install path for JSON, not for the shell. If the install path contained `$(...)` or backticks, the shell ran them every time the statusline refreshed. The path is now quoted so the shell treats it as plain text.
