---
"@autonomos/core": patch
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Fix a permission-mode bug where an agent's record could permanently disagree with the process it was running. Restarting an agent with an explicit mode (`create_agent(resumeSessionId, permissionMode)`) launched the session with that mode but never wrote it down, so the dashboard, the API, and every audit surface kept reporting the old one — which is why restarting an agent "as bypass" looked like it had not worked, and got retried. The record now follows the process.

The `default` permission mode is renamed `ask`, matching the label the UI already showed and ending the collision with the ordinary word (the MCP schema read "Default: default"). Records, templates, and browser settings holding the old spelling migrate on load — no action needed.

Agents can now see each other's permission mode in `list_agents`, and the dashboard's Permission Mode setting says what it actually is: a per-browser preselection, not a server-wide policy. `restart-all` was verified not to change any agent's autonomy, and a test now pins that. See ADR-061.
