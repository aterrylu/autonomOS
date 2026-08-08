---
"@autonomos/dashboard": minor
---

Per-tab and per-runtime auto-Enter for the usage queue (ADR-068). When a Claude Code session is waiting on the usage limit, the dashboard now submits the queued prompt automatically the moment the window resets, scoped correctly per terminal tab and per provider runtime rather than firing globally — so a queued agent resumes on its own without a manual nudge, and one tab's reset doesn't trip another's.
