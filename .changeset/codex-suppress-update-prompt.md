---
"@autonomos/server": patch
---

fix(codex): suppress the in-pane self-update popup that kills spawned sessions

codex (standalone install) shows an update popup at TUI startup; accepting it runs the self-updater, which swaps the binary in place and restarts the process — which our PTY sees as a process exit, so the session is killed. Since autonomOS manages the codex binary version, an in-pane self-update is never appropriate for an orchestrated session.

Every interactive codex spawn (fresh `--remote`, `resume --remote`, and the legacy in-process form) now passes `-c check_for_update_on_startup=false`, which makes codex's TUI `update_prompt` return early with no popup (the gate is `config.check_for_update_on_startup` in codex's `updates.rs`) — removing the trigger entirely, with no restart-vs-real-exit heuristic. A deliberate `codex update` run as a standalone command is unaffected/out of scope.
