---
"@autonomos/server": patch
---

fix(codex): a Codex agent's starting prompt is never read as a command-line option

A Codex agent's starting prompt was passed to Codex in a way that let a prompt beginning with `-` be read as one of Codex's own options. A prompt of `--help` printed Codex's help and exited, a prompt such as "- fix the test" could fail to start, and a prompt naming Codex's bypass option would have run an "ask" agent with no approvals or sandbox while the dashboard still showed "ask". The prompt is now always passed as plain text.
