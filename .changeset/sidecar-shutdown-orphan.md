---
"@autonomos/server": patch
---

Stopping the server no longer leaves a busy Codex agent running in the background. Before, if a Codex agent was mid-turn at shutdown, its daemon was orphaned and kept executing that turn — model calls, shell commands, file writes — with nothing on the dashboard, until the turn finished. The server now waits (up to 3s) for its agents' Codex daemons to exit before it exits, and "restart all" waits for the old daemons before resuming their threads. A second Ctrl+C still exits immediately.
