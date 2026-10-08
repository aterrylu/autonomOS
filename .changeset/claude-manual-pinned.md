---
"@autonomos/server": patch
"@autonomos/core": patch
---

Claude Code agents set to `manual` now really ask before acting. Claude Code 2.1.284+ starts a session that has no permission flag in auto mode, and a resume restores the session's last mode, so a `manual` agent was running auto. `manual` is now pinned through the spawn's settings, plus the flag on a resume.
