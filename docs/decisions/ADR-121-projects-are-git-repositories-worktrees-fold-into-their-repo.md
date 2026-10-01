## ADR-121: Projects are git repositories: worktrees fold into their repo, temp dirs set aside

- **Date:** 2026-09-27
- **Decided by:** Terry (human) set the requirement, relayed by TeamLead@autonomOS. The server/UI split and the wire shape were agreed between CodexGemini@autonomOS (server) and Shortcuts@autonomOS (Projects UI).
- **Context:** Terry: "Way too many projects now. In the Codex and Claude apps, projects are per GIT project, so agents started in a worktree of a project count as the same project… and I'm seeing a LOT of 'Unknown' projects." Projects was grouped by exact directory. Measured on his real history:
  - 98 groups.
  - Every "Unknown" was a Claude Code session whose JSONL opens with `queue-operation` records. The first can be 239KB (a headless review embedding its whole prompt and diff). The SDK listing reads only the head, so the cwd was lost.
  - 71% of sessions are headless SDK runs (`entrypoint` sdk-py/sdk-cli).
  - 71 of 95 session directories no longer exist (wt-sync deletes merged worktrees; temp dirs vanish).
  - `git rev-parse` cost ~84ms per directory under load.
- **Decision:** the server groups sessions into projects (`routes/projects.ts` + `projectResolver.ts`); the UI renders.
  1. **Temp first:** /tmp, /private/tmp, /var/folders, the OS tmpdir and scratchpads are `kind: "temp"` before git is asked, since throwaway git repos there aren't projects. A session with no directory at all is also temp. There is no "Unknown" group.
  2. **Git repo:** `git -C <dir> rev-parse --path-format=absolute --git-common-dir` resolves a worktree to its main repo. It runs off the request path (concurrency 4, 2s timeout, no prompts, no network, and `GIT_DIR`-style variables stripped) into a cache. A directory not yet resolved is a plain `dir` until a later poll.
  3. **Learned roots persist** (`$configDir/project-roots.json`, cwd → repo root), so a worktree resolved while it existed keeps its repo after it's deleted.
  4. **Convention fallback:** a directory under `~/.claude-worktrees` that's gone, or is a husk with no `.git`, maps `<repo>-<branch>` to the known repo with the longest matching prefix.
  5. **Claude Code sessions** get `cwd` and `entrypoint` from their JSONL, read in chunks until found (≤2MB), mtime-cached.
  6. **Wire shape:**
     - Project: `{ path: repoRoot ?? dir, name, kind: repo|dir|temp, repoResolvedBy, counts: { visible, headless, removed } }`.
     - Session: `{ cwd, cwdExists, headless }`. `headless` is set for CC `entrypoint` ≠ cli and `codex exec`.
- **Rationale:** grouping is a server concern, so the dashboard, MCP and any other client get one answer. Git is the ground truth for "which project", but it can't describe a deleted directory, and deletions are most of the history; learning roots while directories exist is the only exact source for them. Keeping git off the request path keeps `/api/projects` fast: warm p50 129ms on Terry's real history, including the existing Claude Code listing. The result on that history: 6 visible projects (from 98), 0 "Unknown", temp dirs set aside.
- **Alternatives considered:** four, all rejected.
  - **Resolve git inline on every request:** ~84ms per directory under load, per poll.
  - **Group in the UI only:** every client would have to reimplement git resolution; the browser can't run git at all.
  - **Derive the repo from Claude Code's per-project dir name:** the encoding is lossy (`/` and `-` collide), and Codex and Gemini don't have one.
  - **Raise the fixed head-read cap:** it only moves the cliff; read until found, with a ceiling, instead.
- **Source:** Claude Code session, CodexGemini@autonomOS; TeamLead@autonomOS and Shortcuts@autonomOS in the agent channel, 2026-09-27.
