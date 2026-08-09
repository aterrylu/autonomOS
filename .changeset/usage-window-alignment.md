---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(usage): bar and queue agree on windows; auto-detect toggle selects the credential source (ADR-075)

- The usage-queue button now names WHICH limit is capping (e.g. "Sonnet 7d"), and the Claude/Codex status bars surface a per-model/named-limit chip whenever it exceeds the headline windows — the bar can no longer read 87% while the queue arms at 90%.
- The auto-detect toggle now selects the credential source: ON = Claude Code's login wins (saved key kept as fallback for broken credentials), OFF = saved key wins. Pasting a key flips auto-detect off in the same write.
- Stale usage data re-served during upstream failures is marked (warning glyph, original fetch time) instead of posing as live or blanking the bar; both scanners single-flight concurrent reads to stop multi-tab 429 stampedes; an expired Claude Code token now warns armed queue panes instead of holding silently.
