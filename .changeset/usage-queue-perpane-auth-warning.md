---
"@autonomos/server": patch
---

Fix the usage-queue credential-failure warning to be per-pane, not global. A single shared boolean meant only the first armed pane was warned when usage became unreadable (e.g. an expired session key); a pane armed afterward, while credentials stayed broken, was never told its queued auto-send could never fire — a silent failure of the very contract that warning exists to enforce. Each armed pane is now warned once and re-armed when a real usage signal returns.
