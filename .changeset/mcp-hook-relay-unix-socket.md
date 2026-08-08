---
"@autonomos/server": minor
---

Move `/mcp` and the agent hook relay off the public TCP listener onto an internal Unix control socket (`$configDir/control.sock`), reachable only by same-user processes on the box (ADR-055 PR A). This is the structural half of closing the MCP exposure: the orchestration tools (`create_agent`, `kill_agent`, `set_manager`, …) are no longer served on the network port at all, and the hook relay ingests over the socket rather than the port.

**Breaking transport change:** an external MCP client pointed at `http://host:3100/mcp` no longer reaches the tool server — the endpoint is served on the control socket, so a remote client now needs a tunnel or a local forwarder (and still the auth token). On-box clients and autonomOS-spawned sessions are unaffected. Paired with PR B (per-agent identity, #293) and the earlier auth-on-`/mcp` fix (#281, ADR-054).
