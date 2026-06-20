---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Make the Claude Usage plugin zero-touch: auto-detect the session with no manual cookie paste. Claude Code injects `CLAUDE_SESSION_COOKIE` into the processes it spawns, so a SessionStart hook relays it to a dedicated, loopback-only, never-logged endpoint where it's held in memory (never written to disk) and used by the usage plugin. Works on any install once an agent has run; a manually-pasted key still overrides it, and an `autoDetectClaudeSession` toggle (default on) opts out and drops the in-memory cookie. The panel shows "Auto-detected from Claude Code" when the credential is inherited.
