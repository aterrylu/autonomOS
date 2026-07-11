---
"@autonomos/dashboard": minor
"@autonomos/server": minor
---

Add a per-pane statusline for Codex and Gemini agents. Codex has no in-terminal statusline mechanism (unlike Claude Code's `--settings statusLine`), so a new dashboard-chrome bar under each terminal pane surfaces the same at-a-glance identity + activity: `[ProviderIcon] Name@project · ↑Manager · ↓N reports   🌿branch · Status`. Identity and hierarchy come from `/api/agents`, live status from `/api/hooks`, and the git branch is resolved server-side (async + cached, ridden onto the `/api/agents` response). Provider and live status ride in the existing per-provider agent icon. Codex/Gemini always show the bar; Claude Code shows it only when its in-terminal statusline is disabled, so a Claude pane is never double-barred. Live token/context-% and a specific model name are intentionally omitted — neither is reachable honestly today (the gateway's non-creator Codex daemon client never receives token-usage events, and `template.model` is not yet plumbed to providers at spawn).
