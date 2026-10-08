---
"@autonomos/dashboard": minor
---

Projects are grouped by git repository: sessions from a repo's worktrees and subdirectories appear under the repo, each row showing its branch (or worktree). Automated runs (SDK / `codex exec`, e.g. PR review bots) are hidden behind "Show N automated runs", sessions from deleted directories sit behind a per-project toggle, and test/temp directories fold into one collapsed "Other" group. Resuming a worktree session resumes it in its own worktree.
