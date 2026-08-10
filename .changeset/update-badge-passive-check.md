---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Passive update badge (ADR-077 §6): the server checks GitHub Releases ~daily (cached, jittered, off-request, `updateCheck: false` in settings.json to disable) and exposes additive `latest` / `updateAvailable` / `checkedAt` fields on `GET /api/system/version`; the dashboard status bar renders a passive "vX.Y.Z available" pill pointing at `autonomos upgrade`. The dashboard never contacts GitHub, the version endpoint never blocks on the check, and there is deliberately no update button — the CLI owns the verified, auto-rolled-back upgrade.
