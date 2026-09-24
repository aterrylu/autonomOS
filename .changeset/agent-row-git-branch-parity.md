---
"@autonomos/core": patch
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(agents): show "project · branch" on every agent row, not just Claude Code

The branch on an agent row's bottom line came only from Claude Code's session
JSONL, so Codex and Gemini rows showed the folder with no branch. The server now
reads the branch from each agent's working directory (`.git`, including git
worktrees; a non-git folder shows just the folder), sends it with the agent, and
keeps it current when an agent checks out a different branch mid-session.
