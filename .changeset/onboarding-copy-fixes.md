---
"@autonomos/dashboard": patch
---

fix(dashboard): first-run copy — drop internal tool names and stale claims from user-facing text

Findings F5 from the onboarding audit (a non-technical newcomer's first ten minutes, walked on an isolated instance). Every change is copy; no behaviour changes.

- **Login screen** now says how to get the token back: "Find your token in the install output, or run `cat ~/.autonomos/token` in a terminal" (was "…or in `~/.autonomos/token`", a dotfile path a non-developer can't open).
- **Empty states speak to the person, not the MCP surface.** Org chart: "Create an agent, then ask it to spawn helpers — managers and their reports appear here" (was "use `set_manager()`"). Presets: plain-language explanation that names the real `+ New` button (was "New preset", a button that doesn't exist, plus `create_env_preset`). Schedules: "created by agents, not by hand" (drops the `create_schedule` name; keeps the ask-an-agent examples). Notifications: "When an agent sends you a message, it appears here" (was "via `--brief`").
- **Runtime cards**: "After installing, restart autonomOS (autonomos restart)" (was "Restart server after installing"), and the hooks badge reads "Live status needs a one-time setup for this runtime". That badge is currently unreachable — every provider declares `hooks.requiresSetup: false` — so this is future-proofing, not a visible change.
- **`.env.example`** no longer claims auth can be disabled ("Leave unset or empty to disable auth (open access)"); auth has been always-on since the token work, as the README already says.
- **`AGENTS.md`** synced with `CLAUDE.md` on four stale facts a newcomer's AI assistant would read: the layout engine (dockview, not a binary tree), the spawn flags (permission modes per ADR-045/061, not a lone `--dangerously-skip-permissions`), where the HTTP MCP server lives (internal control socket, ADR-055, not "Claude Desktop, CI"), and the full shared tool list.
