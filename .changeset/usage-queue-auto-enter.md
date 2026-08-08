---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Usage-queue auto-Enter now works per provider and is scoped per terminal tab and per runtime (ADR-068). The auto-submit that resumes a waiting session the moment its usage window resets was previously Claude-scoped; it now covers each provider through a `NormalizedUsage` core with `normalizeClaude`/`normalizeCodex` adapters and server-side per-provider resolution, so a Codex session queued on its own limit resumes the same way a Claude Code one does. Scoping the reset per tab and per runtime means one tab's window reset no longer fires another tab's queued prompt.
