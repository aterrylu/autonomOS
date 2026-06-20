---
"@autonomos/server": minor
"@autonomos/core": minor
---

Codex agents now spawn as a per-agent `codex app-server` daemon (sidecar) + a `codex --remote` TUI in the terminal pane — the foundation (A1) for native, terminal-preserving Codex inter-agent communication.

Codex 0.141's app-server protocol lets an external client inject a turn into a live thread that the terminal TUI is also attached to (the native equivalent of Claude Code "channels"). This PR wires the spawn topology and lifecycle: the runtime picks a free loopback port, starts the daemon, awaits its readiness, then spawns the `--remote` TUI against it, and disposes the daemon (a separate process) at every PTY-kill site. A new optional `AgentProvider.buildSidecar` hook keeps the runtime provider-agnostic; `spawnAgent` becomes async. Inbound delivery, status, and outbound/org-tooling parity build on this in follow-up PRs.
