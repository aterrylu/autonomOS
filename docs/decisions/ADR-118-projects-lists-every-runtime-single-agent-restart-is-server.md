## ADR-118: Projects lists every runtime; single-agent restart is server-side; Gemini keeps its session

- **Date:** 2026-09-26
- **Decided by:** Terry (human) set the requirement; TeamLead@autonomOS approved the plan (items 1-3 as one bugfix PR, external adopt as the next PR). CodexGemini@autonomOS investigated and implemented it.
- **Context:** Terry reported two failures with a Codex agent.
  - Right-click → Restart "literally did nothing", twice.
  - After a manual kill, the agent was nowhere in Projects, so it couldn't be resumed. He asked that agents show in Projects "regardless of their runtime, with the runtime indicated".
  - Measured on main (5c9cfad3):
    - **Restart** was two client calls (kill, then attach). Every failure of either call went only to the browser console; the store's `status` string that a failed resume wrote was never rendered anywhere. Worse, `killAttachment` only *signals* the old process, so the attach could respawn while it still ran, e.g. two Codex daemons appending to one thread.
    - **Projects** listed only Claude Code sessions. The Codex hook from #369 still returned `[]`, and Gemini had nothing. A managed agent only enriched an existing Claude Code row, so an exited Codex or Gemini agent was invisible.
    - **Gemini restart** respawned a bare `gemini` every time, silently starting a new chat.
- **Decision:** three changes.
  1. **Server-side single-agent restart**, `POST /api/agents/:id/restart` (`restartAgent`). It stops the agent, WAITS for its process and daemon to exit (the restart-all bound), then respawns it from its record in the same conversation.
     - Refusals are typed statuses: 409 if already restarting or during restart-all, 404, 503 while the server stops.
     - A failed respawn leaves the agent crashed, never running without a process, and posts a notice on the agent.
     - The dashboard's Restart makes that one call and always shows the outcome in a new action toast ("Restarted X" / "Restart of X failed: <reason>"). A failed resume uses the same toast.
  2. **Gemini keeps its conversation.**
     - A fresh spawn names its session with the agent's id (`--session-id`); a respawn uses `--resume <id>`.
     - A `hasResumableSession` pre-flight (`findGeminiSession`) looks where `--resume` looks: the cwd's project, under the child's `GEMINI_CLI_HOME`. It's three-state: found; positively absent (start fresh, with a notice); can't tell (throw, so the runtime fails open and resumes).
     - All measured on gemini 0.46.
  3. **Projects lists every runtime.** Codex and Gemini sessions are read from each CLI's own storage (`sessionScanners.ts`).
     - The scan is read-only, bounded (400 files per runtime, newest first; 256KB read per file), mtime-cached, tolerant of malformed files, and runs concurrently with the Claude Code listing.
     - A managed agent is matched by thread (Codex) or session id (Gemini), and its row carries the agent's resumable id under the agent's own directory.
     - A managed agent with no discoverable session still gets a row.
     - Codex and Gemini report cwd as a realpath, so a scanned cwd is mapped back to the raw path the user knows.
     - External (never-managed) Codex/Gemini rows are listed, and clicking one says resume isn't supported yet; adopting them is the next PR.
  4. **The restart's wait window is owned** (from review):
     - A kill during it WINS: it's recorded, and the agent stays stopped instead of being respawned.
     - A reattach during it is refused (409).
     - The "it is stopped" notice fires only when the agent really was marked stopped.
     - A server stopping mid-respawn leaves the record `running` for the next boot.
     - Adoption is its own provider capability (`adoptsExternalSession`, Claude Code only), because Gemini's new resume pre-flight must not open the adopt path early.
  5. **Deferred, deliberately:**
     - A post-restart survival check ("Restarted" means it launched; the existing crash nets cover early exits).
     - Keeping Codex/Gemini rows when the Claude Code listing fails (today that's a visible 500, pinned by a test).
- **Rationale:** a restart is a server lifecycle operation.
  - Only the server can wait for the old process to exit, and only a single call has a single outcome to report.
  - The Gemini pre-flight meets ADR-100's rule: the destructive onExit net arms only behind a pre-flight that proved the session exists. It finds the session file, as Claude Code's does.
  - Reading each CLI's own session files, rather than spawning `codex`/`gemini` per directory, keeps `/api/projects` cheap. Measured with 5,000 Codex rollouts and 3,000 Gemini sessions at load 30-40: warm p50 21-65ms, p95 147-267ms; 20-39ms warm on this machine's real history.
- **Alternatives considered:** four, all rejected.
  - **Keep client-side kill → attach and only surface its errors:** the respawn-before-exit race remains, and two calls can half-succeed.
  - **Use `gemini --list-sessions` for discovery and the pre-flight:** it spawns a Node CLI per directory per poll, and only lists the current directory's sessions.
  - **Codex's `hasResumableThread` style for Gemini:** Gemini resumes by session id, which a pre-flight can prove, so the Claude Code-style hook is the honest fit (ADR-100).
  - **Realpath every Projects group key:** it would rewrite Claude Code's own paths (a symlinked workspace), which the "+" quick-spawn uses.
- **Source:** Claude Code session, CodexGemini@autonomOS; Terry's report and TeamLead's GO in the agent channel, 2026-09-26.
