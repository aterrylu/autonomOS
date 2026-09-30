## ADR-132: Record sidecar daemons on disk and reap an orphan before starting a new one

- **Date:** 2026-09-30
- **Decided by:** an agent (CodexGemini) proposed it after reproducing the bug; TeamLead approved it for Terry.
- **Context:** A Codex agent runs as a TUI attached to a per-agent `codex app-server` daemon (the sidecar). The daemon's pid lived only in the server's memory. When the server dies without disposing the daemon (SIGKILL, a crash, power loss), the daemon keeps running, reparented to init, and keeps the agent's conversation thread loaded. A new daemon cannot load a thread another daemon holds.

  Measured on codex 0.157.1 on an isolated instance:
  - After a server SIGKILL and reboot, the resumed agent's new daemon reports an empty `thread/loaded/list`, so codexControl waits forever ("no Codex thread yet") and inbound never lands.
  - Codex starts a thread's MCP servers when it loads the thread, so the agent's channel server never started either.
  - A graceful `/restart` failed the same way while the orphan lived. ADR-118's wait only covers the daemon this server knows about.
  - Killing the orphan made both work.

  SecurityFix-Hardening found it while verifying #464 and reproduced it on main (TCP); it isn't caused by #464's unix sockets.
- **Decision:**
  - **Record every daemon.** Each started daemon is written to `$configDir/sidecars/<agentId>.json` (`{pid, endpoint, startedAt}`, 0600, in a 0700 directory, written atomically). It is removed when that daemon has actually exited, and only if the record is still that daemon's.
  - **Reap before any start.** Before any sidecar daemon starts for an agent (fresh spawn, resume, crash-net respawn, restart), a recorded daemon that is still alive is stopped the Codex way: SIGTERM, a second SIGTERM, then SIGKILL, waiting for it to be gone.
  - **Two guards:**
    - The pid is only signaled when its command line (`ps -ww -o command=`) still carries `app-server --listen <recorded endpoint>`, matched verbatim. A recycled pid belonging to anything else is never touched, and the stale record is dropped. On Linux the exact argv is read from `/proc/<pid>/cmdline`; `ps`'s joined line is matched on the whole endpoint, so paths with spaces work. A live pid whose command line can't be read is never signaled: its record is KEPT for a later try, and the agent gets a notice.
    - Every removal after an await is compare-and-delete, so a concurrent reap that already started a newer daemon never loses that daemon's record. The reaper never throws into the spawn or boot path, and the boot sweep lets every reap settle.
    - A daemon this process itself runs is never reaped from here. Its own lifecycle disposes it.
  - **Boot sweep.** At boot, every recorded orphan is reaped (awaited) before `resumeActiveAgents`, including agents that won't be resumed.
  - **If a reap fails,** the agent gets a notice saying it may not receive messages.
  - **Clearer log.** The "no Codex thread" log now names the held-thread cause next to "TUI not attached".
- **Rationale:**
  - The pid has to survive the process that knows it, so it goes on disk.
  - Stopping the orphan before the new daemon starts is the only order that works: once the new daemon is up without the thread, nothing retries the load.
  - The command-line guard makes a stale record harmless.
  - Matching on the RECORDED endpoint (never a re-derived one) keeps working when the endpoint changes per spawn: the random port today, and #464's per-spawn unix socket path. #464's stale-socket sweep only unlinks paths, so it must run after the reaper, or it hides a live orphan.
- **Alternatives considered:**
  - *Adopt the orphan instead of stopping it.* It has the thread loaded, but its endpoint, permission and environment belong to the dead server's spawn. A dead TUI plus a live daemon isn't a state we can vouch for.
  - *Tie the daemon's lifetime to the server* (process group / `PR_SET_PDEATHSIG`). macOS has no parent-death signal, and a group kill also misses daemons whose group the launcher changes. The records work the same on both platforms and still help if a lifetime tie is added later.
  - *Kill by name* (every `codex app-server`). That would kill the user's own Codex daemons and other instances' agents, which the standing rule against broad kills forbids.
  - *Detect the held thread and retry longer.* It never frees itself, so waiting doesn't help.
- **Source:** Claude Code session (CodexGemini). SecurityFix-Hardening's #464 verification report; the root-cause repro on an isolated instance; TeamLead's go (agent channel, 2026-09-30).
