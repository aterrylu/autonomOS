---
"@autonomos/cli": patch
---

The installer now pre-flights Claude Code: `install.sh` fails fast with a message that names the missing prerequisite (install pointer + login reminder + `SKIP_CLAUDE_CHECK=1` escape hatch) instead of installing a daemon that crash-loops under the supervisor. And when the daemon does fail to come up, the post-install report surfaces the tail of the boot backstop log — the newcomer reads WHY ("Claude Code CLI not found…"), not just "check the logs".
