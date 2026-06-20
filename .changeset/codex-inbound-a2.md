---
"@autonomos/server": minor
---

Codex agents can now RECEIVE inter-agent messages (A2). A `send()` to a Codex agent (or a broadcast) is injected as an attributed user turn into the agent's app-server daemon, rendering inline in its terminal — the native equivalent of Claude Code "channels". The gateway holds a per-agent JSON-RPC control client that discovers the thread, polls `thread/read` for a confirmed-idle window (never injecting mid-turn), and queues messages until the agent is free. Persistent delivery failures surface as dashboard notifications.
