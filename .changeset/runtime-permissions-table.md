---
"@autonomos/core": patch
"@autonomos/server": patch
---

The server now checks each installed CLI's permission options (Claude Code, Codex, Gemini) against the values autonomOS knows, without starting a session, and warns once if a CLI stops accepting one or adds a new one. `GET /api/providers` now reports each CLI's real version and this check. Nothing about how agents are spawned changes yet.
