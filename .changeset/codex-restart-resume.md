---
"@autonomos/core": patch
"@autonomos/server": patch
---

fix(codex): Codex agents survive a server/daemon restart

On codex 0.154 every Codex agent died on restart. Resume no longer passes
permission overrides (codex rejects them on a remote resume; a resumed thread
keeps its original permissions), a never-prompted agent — whose thread codex
never saved — starts a fresh thread instead of failing, a permission-mode change
on resume is refused with a clear notice instead of silently not applying,
resuming an agent keeps its own runtime (it could be switched to Claude Code),
Codex "auto" now says it behaves like Ask (Codex has no auto tier), and the
boot log's ✓ only appears once a resumed agent has actually stayed up.
