---
"@autonomos/server": patch
---

fix(codex): restarting a Codex agent no longer drops a message that was queued for it — it's delivered to the restarted agent (or, if the restart fails, reported as undelivered).
