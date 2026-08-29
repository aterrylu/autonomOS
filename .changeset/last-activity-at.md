---
"@autonomos/server": patch
"@autonomos/dashboard": patch
"@autonomos/core": patch
---

Session recency now survives upgrades (ADR pending). Agent records gain an optional `lastActivityAt` written ONLY by genuine activity (hook events; Codex turn events land via a follow-up) — never by spawn/resume/upgrade, so restarting the server no longer bumps every session to "now". The sidebar prefers it over the CC transcript mtime (which a resumed process touches at boot); records without the field keep today's behavior exactly. Debounced persistence (~30s, forced on turn boundaries), no version churn, downgrade-tolerant.
