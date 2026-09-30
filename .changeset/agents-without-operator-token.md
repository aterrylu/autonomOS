---
"@autonomos/server": patch
---

fix(security): agents no longer receive the server's login token

Every agent used to be given the server's operator token (the one that signs you in to the dashboard). It was in the agent's command line, where other user accounts on the same machine can read it with `ps`, and in its environment when the server was started with `AUTONOMOS_TOKEN` set. Anyone who read it could control the server as you.

- Agents now use only their own per-agent credential. An agent's autonomOS tools (create_agent, schedules, presets and the rest) call the server over the local control socket with it, and the server accepts it only for exactly those tools.
- The server can now tell an agent's request from yours. It logs which agent made each change, and an agent can no longer set or clear an env-preset secret value; only you can, from the Presets tab.
- Agents started before the upgrade keep working until they restart; nothing to do.
