---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Fix silently-dropped starting prompts: delivery-receipt tracking re-delivers the prompt via PTY paste when UserPromptSubmit never arrives, and the auto-trust watcher now retries needle-verified Enters instead of blind bursts. Failures surface as warning notifications in the dashboard.
