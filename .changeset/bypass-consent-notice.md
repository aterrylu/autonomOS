---
"@autonomos/server": patch
---

fix(claude-code): say when a bypass agent is waiting for you to accept Bypass Permissions mode

A Claude Code agent started in bypass mode on a machine where Bypass Permissions mode was never accepted stops on Claude Code's consent screen and waits there. autonomOS never answers that screen (it's your consent to give, and its default is "No, exit"), but it also never said so: about a minute later you got "may have failed to boot". Now a notice tells you right away that the agent is waiting for you to accept, and the boot-failure warning no longer appears for that case. Once you accept in the agent's terminal it starts and runs its first prompt as normal, and Claude Code stops asking on that machine.

Startup notices now also catch their screen when the terminal output arrives split in the middle of a formatting code, which could make Gemini's folder-trust notice miss too.
