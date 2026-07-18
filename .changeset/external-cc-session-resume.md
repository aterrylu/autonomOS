---
"@autonomos/server": minor
"@autonomos/dashboard": patch
---

Resume any external Claude Code session — the ones you started in a terminal, not just the ones autonomOS spawned (ADR-056). Clicking **resume** on a discovered session in the Projects panel used to fail with `failed to resume session`; it now adopts that session into a real managed agent and resumes it with its full conversation intact. Works from the UI and programmatically via the `create_agent` MCP tool (`resumeSessionId`).

Regressed in #165 ("unify Agent + Session"), which collapsed two different id-spaces — a raw Claude Code session id and an internal autonomOS agent id — into one lookup that only ever matched agent records. External sessions have no record, so every resume path 404'd. `spawnAgent` now takes a distinctly-named `resumeSessionId` that resolves against both the agent store and disk.

Also fixes the long-standing dual-id footgun: newly spawned agents now use one id for both (`id == providerSessionId`), so resuming works with whichever id you have. Pre-existing split-id agents resume too, via a `providerSessionId` fallback on `/attach`.

Adoption is deliberately fail-closed — it refuses rather than silently handing you an empty session: providers that can't prove a session exists on disk (Codex, Gemini) are rejected, session ids are validated, and a missing transcript returns a clear error instead of a blank agent. An adopted session never arms the fresh-session safety net, whose reset would replace the session id your conversation lives under — and because that provenance is stored on the agent, later resumes are protected too, not just the first. Reattaching uses the record's own working directory rather than the caller's (and reports clearly if that directory has since been deleted), so a wrong or stale path can't cause a silent fresh start.
