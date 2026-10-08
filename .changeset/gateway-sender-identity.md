---
"@autonomos/server": patch
---

fix(security): an agent can't pose as another agent by renaming its Claude Code session

Messages between agents, and the agent list, named an agent by its Claude Code session title when it had one. The agent itself can change that title (`/rename`), so an agent could rename itself after another agent, send messages that looked like they came from that agent (with replies going to the real one), and receive the other agent's messages while it was offline. Agents are now always identified by their autonomOS name. A renamed session title can still be used to address an agent no other agent is named after.
