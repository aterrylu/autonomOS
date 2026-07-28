---
"@autonomos/server": patch
---

Codex inbound now injects immediately instead of waiting for an idle window. The idle gate duplicated a guarantee Codex already makes (it delivers at its own turn boundaries) and it deadlocked agents blocked in `collaboration.wait_agent` — a blocked thread reads as busy, so the message that would have released the agent was the one being withheld. The queue remains as a retry buffer for real transport failures, and a server restart with inbound still queued now says so instead of dropping it silently. See ADR-060.
