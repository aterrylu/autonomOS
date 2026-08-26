---
"@autonomos/server": patch
---

`install-source.sh` now migrates `AUTONOMOS_TOKEN` from the old install tree's `.env` into the new managed clone, so a migration never changes the token your dashboard login uses (ADR-089 — the auth-continuity invariant, pinned by a contract test). Other `.env` overrides are deliberately reset to defaults and listed by name in the install output with a restore hint; a `.env` without a token gets an explicit "your login token is about to change" warning. v0.6.0's migration dropped the file silently — if it locked you out, your token is in `~/.autonomos/token`.
