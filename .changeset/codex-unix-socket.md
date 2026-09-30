---
"@autonomos/server": patch
---

fix(security): other users on your machine can no longer run commands through a Codex agent

Each Codex agent's background process used to listen on a local network port with no password, and it can run any command. Any program on the same machine, including one run by a different user account, could connect to it and run commands as you.

- It now listens on a private socket file that only your user account can open.
- If your Codex is too old to support that (or the socket can't be set up safely), the agent still starts, the old way, and you get a notification that explains the risk and says to upgrade Codex.
- Nothing to do for current Codex versions. Running agents switch over the next time they restart.
