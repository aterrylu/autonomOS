---
"@autonomos/server": patch
---

fix(codex): a Codex agent resumed after the server crashed (or restarted while an old daemon lived) now receives messages again — the orphaned `codex app-server` daemon that kept its conversation loaded is stopped before a new one starts.
