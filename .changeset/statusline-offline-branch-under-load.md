---
"@autonomos/server": patch
---

fix(statusline): stays connected and keeps the branch when many agents are running

With dozens of agents, the agent statusline often switched to
`[autonomos · offline]` and its branch kept disappearing, even though the
server was fine. Two causes, both fixed:

- **The branch** came from running `git` on every refresh with a 100ms limit,
  which a busy machine missed almost every time. It's now read directly from
  the repository (worktrees included), so it no longer flickers.
- **"offline"** appeared whenever one refresh was slow: each refresh starts
  fresh with a 200ms limit, and on a busy machine just starting up can take
  that long. The statusline now remembers the last answer and keeps showing
  it through a slow moment. It dims only after a minute without an update,
  and says "offline" only when the server is actually unreachable (or after
  five minutes of silence).

The server also no longer freezes for up to a second each time a dashboard
loads (a process listing ran in the foreground), and the Projects list stops
re-reading every untitled conversation on each refresh. Either one could make
every agent's statusline say "offline" at the same moment.
