---
"@autonomos/server": minor
---

The MCP `create_agent` tool now accepts a `provider` field, so agents (e.g. Dispatcher) can spawn Codex or Gemini runtimes — not just Claude Code. Previously provider selection existed only in the dashboard's Create Agent panel, so agent-initiated spawns were locked to claude-code. Wired through both MCP transports (HTTP + channel server) and forwarded to the spawn path.
