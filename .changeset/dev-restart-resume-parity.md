---
"@autonomos/core": patch
"@autonomos/server": patch
---

Fix Claude Code agents disappearing on server restart (provider parity). Claude Code writes its session JSONL lazily — on the first turn, not at session creation — so a never-conversed agent had no `--resume` target, and the unconditional `claude --resume <id>` crashed on boot, marking the agent exited so it dropped out of the org chart. Codex never hit this (it degrades to a fresh thread). The fix adds an optional `hasResumableSession()` provider hook: when no resumable session exists on disk, the runtime spawns a fresh session reusing the same id (lossless — there was no prior conversation). The previously Codex-only immediate-resume-crash safety net is also generalized to all providers (regenerate session id + clear thread id) so a corrupt/un-resumable session can't crash-loop. See ADR-049.
