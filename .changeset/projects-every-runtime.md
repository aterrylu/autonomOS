---
"@autonomos/core": patch
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Restart and Projects now work for Codex and Gemini agents.

- **Restart** now always tells you what happened ("Restarted X", or why it failed) instead of silently doing nothing. It also waits for the old process to exit before starting the new one, so a restarted Codex agent can't briefly run twice on one conversation.
- **Projects** now lists Codex and Gemini sessions, with their runtime icon. Every autonomOS agent shows under its directory even after it exits, and Resume brings it back in the same conversation.
- **Gemini** agents now keep their conversation across a restart. Before, every restart silently started a new chat.
