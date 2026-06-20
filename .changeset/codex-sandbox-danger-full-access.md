---
"@autonomos/server": patch
---

Codex agents now run with `danger-full-access` (no OS sandbox), fixing the "could not find bubblewrap on PATH" warning on Linux. autonomOS is the trust boundary, so Codex's own OS sandbox (bubblewrap/Seatbelt) is disabled — set on BOTH the app-server daemon (`-c sandbox_mode`) and the `--remote` TUI (which creates the thread and otherwise forces `workspace-write`); setting it on only one layer loses to the other's default. Autonomous agents use `--dangerously-bypass-approvals-and-sandbox` (the Claude Code `--dangerously-skip-permissions` equivalent); supervised agents drop the sandbox but keep approval prompts.
