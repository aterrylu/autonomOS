---
"@autonomos/core": patch
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Fix the create-agent panel showing Codex as having no live status. The capability row was hardcoded to "Live status via hooks" (`hooks.eventCount > 0`), but Codex sources live status from its app-server event stream and correctly declares zero hook events — so it read as unsupported. Added a dedicated `liveStatus` capability (`supported` + `method: hooks | event-stream | none`) decoupled from hooks; the row now reads "Live status" and Codex shows it as supported.
