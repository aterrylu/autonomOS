## ADR-029: Desktop Embeds Built-in Server (Reverses Part of ADR-028)
**Date:** 2026-05-25
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session (Phase 1B.2 testing — discovered after the thin-client architecture was working end-to-end)

**Context:** Phase 1B.2 shipped the pure thin-client architecture per ADR-028: Desktop never runs a server, always connects to a daemon supervised by launchd/systemd-user (or a remote server). Worked correctly — drag, multi-window, clean quit-cleanup, all functioning. Then Terry pushed back on the UX: requiring a separate `curl install.sh | sh` step before the Desktop is usable is a substantial friction barrier for new users. Comparable apps that ship Built-in functionality (Docker Desktop, OrbStack, Postgres.app — Built-in everything; the GUI is the runtime) achieve a "open the app, it just works" experience that pure thin-client architectures cannot. The pure-thin-client design from ADR-028 is *correct* for forge-style deployments but *wrong* for a new-user-first-launch UX. We need both: zero-friction Built-in mode for new/casual users, AND the existing thin-client mode for users who already have a daemon or want to connect to a remote server.

The original PR #172 / Phase 1B.1 attempt at an embedded server failed because of a destructive PTY corruption race: two servers (the embedded child AND a separately-installed LaunchAgent daemon) attached to the same `~/.autonomos/` state simultaneously. ADR-028 over-corrected by banning embedded mode entirely. ADR-029 reintroduces embedded mode WITH a mutual-exclusion contract that prevents the original race.

**Decision:** The autonomOS Desktop app supports **two modes**, mutually exclusive on any single Mac for any single `AUTONOMOS_CONFIG_DIR`:

1. **Built-in:** The Desktop spawns `autonomos-server` as an Electron child process at app launch. The server lives + dies with the Desktop process. Agents pause when the Desktop quits (state persists on disk; resumed next launch via `claude --resume` per the L1 persistence model from Phase 1A.1 design notes). This is the **default** mode at first launch for a user with no existing daemon.

2. **Server:** The Desktop is a pure thin client over an `autonomos-server` reachable at a URL+token. The server may be a launchd/systemd-user daemon on this Mac (set up via `autonomos install-service`) OR a remote server (forge, VPS). From the Desktop's perspective these are **the same mode** — both are "connect to a URL." The distinction "local persistent vs remote" exists only in the install flow (where the user runs `curl install.sh`) and the UI label (e.g. "This Mac (Always-on)" vs "forge"). Internally a `Connection` is `{ id, name, url, token }` regardless of where the URL points.

**Mutual exclusion contract** (the fix for the PR #172 PTY race):

- The pid file at `~/.autonomos/autonomos.pid` (already shipping from `packages/server/src/pid-file.ts`) is the single source of truth for "is there an owner of this config dir?" Format: `{ pid, port, version, startedAt }`.
- Any process that wants to start a server (Desktop Built-in, `autonomos start` CLI, LaunchAgent) must atomically claim the pid file. If a live owner exists (pid alive via `process.kill(pid, 0)` AND port responsive on `/api/system/version`), the new process MUST NOT start its own server. Instead:
  - Desktop in Built-in mode → switches to thin-client mode, connects to the existing server at `localhost:<that-port>`.
  - `autonomos install-service` → refuses with a clear error message instructing the user to quit the Desktop first.
- Stale pid file (pid dead OR port unresponsive) → cleaned up and overwritten.
- On clean shutdown, the owning process removes its pid file.

**Migration paths between modes** (in-app, no Terminal required):

- **Built-in → Server (persistent local):** Settings panel toggle *"Keep autonomOS running in the background"* → ON. Triggers in-process `autonomos install-service` invocation, which sets up the LaunchAgent / systemd-user service. The Built-in server child is gracefully shut down; the LaunchAgent picks up the same `~/.autonomos/` state. Desktop reconnects as a thin client to the new daemon. Progress is shown via an in-app dialog (no Terminal output).
- **Server (persistent local) → Built-in:** Same toggle → OFF. Uninstalls the LaunchAgent via in-process `autonomos uninstall-service`. Desktop spawns a Built-in server on its next agent-needing action.
- **Quit-time prompt:** when in Built-in mode and quitting with running agents, a non-modal banner offers: *"Make autonomOS Server always-on"* (one-click migration to persistent mode) or *"Quit anyway"*. Power-user graceful path without requiring Settings panel discovery.

**UI vocabulary** (no engineering jargon exposed to users):
- "Built-in" = embedded mode (Desktop owns the server's lifecycle).
- "Always-on" or "Persistent" = LaunchAgent/systemd-user mode.
- "Remote" = HTTP connection to another machine.
- Never expose "daemon", "launchd", "embedded", or "thin client" in UI copy.

**First-launch UX:** zero-friction. No Welcome screen for a brand-new user. The Desktop boots into a brief splash ("Starting autonomOS…", ~1-2s while the Built-in server comes up), then the dashboard appears. The Welcome screen is now reserved for "Add another Server" flows from the Connection sidebar.

**Connection sidebar:** retained from ADR-028's design. Even with Built-in being the dominant path, power users with multiple servers (this Mac + forge) appreciate the multi-window switching. Collapsed by default when only one connection exists. "This Mac" is always pinned at the top with a subtitle indicating its mode ("Built-in" or "Always-on").

**Rationale:**
- **Fixes the ADR-028 UX friction without re-introducing the PR #172 bug.** The mutual-exclusion contract (atomic pid-file claim + liveness check) structurally prevents two servers from ever competing for the same `~/.autonomos/` state. The bug was caused by ADR-028's predecessor lacking this contract, not by embedded mode itself.
- **Matches Docker Desktop, OrbStack, Postgres.app.** Those apps own everything in-process for casual users AND offer an "always-on" upgrade path for power users. Their users describe this as "magic." Our Phase 1B.2 thin-client requirement is comparatively friction-heavy.
- **Preserves the thin-client model for everyone who already wants it.** Forge users, anyone with an existing LaunchAgent, anyone connecting to a remote server — these flows are unchanged. ADR-029 is **additive**, not a replacement.
- **Persistent-local and remote collapsing into one "Server" mode is architecturally clean.** Both are `{ url, token }`. The Desktop's connection-handling code path is one path, not two.
- **The quit-time "Make always-on" prompt is a Trojan horse for the right behavior.** Users who run agents long enough to hit the "agents will pause" warning are exactly the users who benefit from persistent mode. The UI catches them at the right moment.

**Alternatives considered:**
- **Three modes (Built-in, persistent-local, remote).** Initially proposed; collapsed into two when Terry observed that persistent-local and remote are architecturally identical from the Desktop's perspective.
- **Stick with pure thin-client (ADR-028).** Rejected because the first-launch friction is a genuine product-experience problem. n8n Desktop was sunset partly because casual users couldn't get started fast enough — ADR-028's predecessor was making the same mistake.
- **Two modes with totally separate UI surfaces.** Considered: "Local mode" tab vs "Connections" tab. Rejected because users don't think in modes; they think in "where is my work running." Unifying persistent-local and remote into one "Server" concept is the user-facing simplification.
- **Built-in default + "install-service" as the only persistence path (no in-app toggle).** Rejected: discoverability is poor. The Settings toggle + quit-time prompt are the affordances that surface the persistence option to users who'd benefit.

**Implications:**
- **Phase 1B.2's thin-client code stays.** It IS the implementation of the "Server" mode. Built-in mode adds a new code path; remote mode is unchanged.
- **The webview drag, multi-window, quit-cleanup work from Phase 1B.2 all carries forward.** No rework of those pieces.
- **PR #172's salvageable code re-enters circulation.** The `server-supervisor.ts` from that PR (which spawned the embedded server) is the seed of the new Built-in implementation, but rewritten with the mutual-exclusion contract.
- **Server-side change required.** `packages/server/src/pid-file.ts` already writes the schema; we need to add an atomic-claim helper using `open(O_CREAT | O_EXCL)` (or equivalent) so two processes racing to claim the pid file can't both win. ~30 LOC.
- **CLI changes required.** `autonomos install-service` and `autonomos start` must check the pid file and refuse with a helpful error if the Desktop already owns the config dir.
- **Pure-thin-client ADR-028 is partially superseded.** ADR-028 said "Desktop never embeds." ADR-029 says "Desktop CAN embed, under a mutual-exclusion contract." The other ADR-028 elements (multi-window, cookie auth, deep links, audit fixes, etc.) all remain in force.

**Design doc:** `docs/research/desktop-embedded-server.md`

**Update (2026-06-29, ADR-051):** The Electron Built-in/embedded server mode is cancelled — see ADR-051; `packages/app/`, the server's `--embedded` flag + `embedded-mode.ts`, and the design doc above (`desktop-embedded-server.md`) are removed. The **mutual-exclusion contract (atomic pid-file claim + liveness check) STAYS** — it still prevents two daemons from racing on the same `~/.autonomos/` state, independent of any desktop. (The shared real-spawn integration harness that used `--embedded` for ephemeral-port readiness was rewritten to parse the server's standard "listening on" startup log line, and renamed `helpers/test-server.ts` since it was never Electron-specific.)
