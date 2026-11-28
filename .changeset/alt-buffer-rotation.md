---
"@autonomos/dashboard": patch
---

A full-screen agent terminal (Claude Code with no-flicker on) no longer shows its bottom rows at the top the first time you open it, or after a reconnect, when the agent's terminal was last sized smaller (by another tab or device, a split, or its starting size). Until now only a hard refresh fixed it. The cause was a bug in the terminal library when it shrinks; the dashboard now works around it on every resize.
