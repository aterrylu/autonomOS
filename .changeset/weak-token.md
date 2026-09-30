---
"@autonomos/server": minor
"@autonomos/cli": minor
---

feat(security): weak operator tokens.
- A token under 32 characters now triggers a warning on every start, and the dashboard is told so it can show one too. It keeps working, so an upgrade never locks you out.
- A brand-new install refuses to start with a weak token while listening on the network. Use `--allow-weak-token` to override, or `--host=127.0.0.1`.
- New: `autonomos token rotate` replaces the token with a strong one, takes `AUTONOMOS_TOKEN` out of your `.env`, and prints a new sign-in link. `autonomos token status` shows whether your token is strong.

See ADR-130.
