---
"@autonomos/dashboard": patch
---

A full-screen agent terminal (Claude Code with no-flicker on) no longer ends up with its bottom half at the top after the dashboard window was resized or re-laid out while in the background. Until now only a hard refresh fixed it. A terminal now changes size only together with the agent's terminal, and a background window waits for focus before fitting, as it already did before sending its size.
