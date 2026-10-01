---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Fix Codex panes freezing (the wheel stopped scrolling) and Claude no_flicker panes going black after a reconnect. A reconnect now restores the terminal modes a full-screen agent set at startup, replays at the agent's terminal size, and asks the agent to repaint when the replay lost its start. A busy server no longer forces every pane to reconnect.
