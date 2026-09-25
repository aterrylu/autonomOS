---
"@autonomos/server": patch
---

The warning about processes that outlive an agent's kill is no longer silently dropped on a heavily loaded machine: its process listing now gets up to 10s (it runs in the background, so nothing waits on it) instead of 1s.
