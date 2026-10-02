---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Codex panes scroll their transcript again: Codex now runs inline instead of on the alternate screen it recently switched to, where the mouse wheel could only walk the prompt history or did nothing. Claude no_flicker panes no longer go black after a reconnect or page reload: the replay restores the screen modes Claude set at startup, is drawn at the agent's terminal size, and asks Claude to repaint when needed. A busy server no longer forces every pane to reconnect.
