# autonomOS Desktop — Built-in Server with Mutual Exclusion

**Status:** Approved for implementation (2026-05-25). Codifies ADR-029.
**Supersedes (in part):** `desktop-as-thin-client.md` — that doc's thin-client implementation IS the "Server" mode in this design.
**Decided by:** Terry + Feature Worker

## TL;DR

The Desktop has two modes:

1. **Built-in** — Desktop spawns `autonomos-server` as a child process. Default at first launch. Agents pause when the app quits, state persists, resumed on next launch.
2. **Server** — Desktop is a thin client over a URL+token. The server may be on this Mac (persistent via launchd) OR remote (forge). Same code path; URL is the only difference.

A **mutual-exclusion contract** prevents two servers from ever competing for the same `~/.autonomos/` config dir on a single Mac. The contract is enforced via atomic claims on `~/.autonomos/autonomos.pid` (which already ships from Phase 1A.1).

First launch: zero-friction. Brief splash → working dashboard. No Welcome screen.

Persistence: an in-app Settings toggle ("Keep autonomOS running in the background") AND a quit-time prompt for users with running agents convert Built-in mode to persistent (LaunchAgent-supervised) mode without ever opening Terminal.

## Why we're reversing course on ADR-028

ADR-028 banned embedded mode entirely because PR #172 had a destructive PTY corruption bug. The bug's root cause was lack of mutual exclusion, not embedded mode per se. ADR-028 over-corrected.

Real-world friction discovered after Phase 1B.2 shipped: requiring `curl install.sh | sh` before the Desktop is usable is a substantial barrier for new users. Docker Desktop, OrbStack, and Postgres.app are the comparison points — they ship Built-in functionality and have "open the app, it just works" UX. Pure thin-client cannot deliver that.

ADR-029 reintroduces embedded mode WITH the mutual-exclusion contract that was missing in PR #172. Three modes simplify to two when we observe persistent-local and remote are architecturally identical.

## The two modes

### Built-in

```
┌─────────────────────────────────────────────────────┐
│  autonomOS Desktop process                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  Electron main                                │  │
│  │   ├── BrowserWindow (renderer + webview)      │  │
│  │   └── child: autonomos-server                 │  │
│  │              │                                │  │
│  │              └── ~/.autonomos/ (state)        │  │
│  │                  ~/.autonomos/autonomos.pid   │  │
│  │                    {pid: <child>, port: N}    │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- The Desktop owns the server's lifecycle. Server starts on Desktop launch; SIGTERM on Desktop quit.
- Server binds to `127.0.0.1:<kernel-assigned-port>`. The Desktop's BrowserWindow loads `http://127.0.0.1:<port>` via the same `<webview>` machinery from Phase 1B.2.
- The connection appears in the sidebar as "This Mac" with subtitle "Built-in."

### Server

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│  autonomOS Desktop          │    │  autonomos-server           │
│  (process A, thin client)   │    │  (process B, independent)   │
│                             │    │                             │
│  webview ────HTTP────────────┼───→│  Hono server, port N        │
│                             │    │     │                       │
│                             │    │     └── ~/.autonomos/ state │
│                             │    │                             │
│  Quits cleanly without      │    │  Supervised by launchd      │
│  affecting B                │    │  (this Mac) OR running on   │
│                             │    │  forge (different machine)  │
└─────────────────────────────┘    └─────────────────────────────┘
```

- Server is supervised by launchd / systemd-user (if local) OR by whatever's running on forge (if remote).
- From the Desktop's perspective, **both are identical**: a `Connection = { id, name, url, token }`. The Desktop is a pure thin client.
- The Desktop knows whether a "This Mac" connection is Built-in vs Always-on by checking whether the pid file's owner is the Desktop's own child PID. Used only for the sidebar label, never for behavior.

## The mutual-exclusion contract

**Invariant:** For any given `AUTONOMOS_CONFIG_DIR` (default `~/.autonomos/`), at most ONE process may be acting as the server at any time.

### Enforcement

`~/.autonomos/autonomos.pid` is the single source of truth. Format (already shipping):

```json
{
  "pid": 12345,
  "port": 53055,
  "version": "0.0.1",
  "startedAt": "2026-05-25T12:34:56.789Z"
}
```

### State machine: "I want to start a server"

```
1. atomically_create("autonomos.pid.lock")
     - On Linux/macOS: open(O_CREAT | O_EXCL) with mode 0o600
     - On Windows: equivalent
     - If create fails (lock held by another process):
         → another start is in progress; back off + retry once after 100ms,
           then fail with "could not acquire start lock"
2. read("autonomos.pid")
     - If file exists:
         a. parse to {pid, port, ...}
         b. is_alive(pid)? — via process.kill(pid, 0)
         c. is_responsive(port)? — GET http://127.0.0.1:<port>/api/system/version (200ms timeout)
         d. If both yes → THIS IS A LIVE OWNER.
                          → release the .lock file
                          → return ALREADY_RUNNING { pid, port }
         e. If either no → stale pid file. Remove autonomos.pid.
3. atomically_create("autonomos.pid")
     - Write our {pid: process.pid, port: ourPort, ...}
4. release the .lock file
5. start serving on ourPort
6. On clean shutdown (SIGTERM, app.quit()):
     - Remove autonomos.pid
```

### Behavior per caller

| Caller | If ALREADY_RUNNING (live owner) | If no owner |
|---|---|---|
| **Desktop Built-in startup** | Switch to thin-client mode, connect to `127.0.0.1:<port>` | Claim, spawn embedded child server |
| **`autonomos start` CLI** | Print "Server already running at port N (pid M). Connect via `autonomos status` or open autonomOS.app." Exit 0. | Claim, start server as foreground process |
| **`autonomos install-service`** | Print "A server is already running (pid M). Quit it first, then re-run install-service. Tip: if it's running inside autonomOS.app, quit the app." Exit 1. | Set up LaunchAgent, which on its next boot will claim |
| **LaunchAgent at boot** | Refuse with log entry; launchd will retry on next boot | Claim, run as background daemon |

### Failure modes handled

- **Crash mid-write of pid file** → next process reads a corrupt file → treats as no owner, proceeds to claim. The `.lock` file ensures only one such process is doing this at a time.
- **Process killed without removing pid file** → file is stale → next process detects via `process.kill(pid, 0)` returning ESRCH OR port not responding → cleans up + claims.
- **Two processes racing the claim** → only one wins the `O_EXCL` create on `.lock`. The other fails fast.
- **Long-running upgrade** → upgrade process holds the lock; new starts wait + retry once; if upgrade takes >100ms, new starts return a clear error.

## UX flows

### First launch (no daemon, no Built-in, no connections)

```
1. User double-clicks autonomOS.app
2. Splash window appears (~600x400 centered): "Starting autonomOS…"
3. Behind the splash:
     a. Desktop calls start-server flow (state machine above)
     b. No live owner → claim pid file → spawn autonomos-server as child
     c. Wait for child stdout: "AUTONOMOS_READY port=NNNNN" (Phase 1A.1 contract)
     d. Generate a "This Mac" Connection entry (id: "local", type derived
        from pid-file ownership = Built-in)
     e. Persist to ~/Library/Application Support/autonomOS/config.json
4. Splash transitions to main BrowserWindow loading http://127.0.0.1:<port>
5. Total time-to-dashboard: ~1-2 seconds on a modern Mac
```

### Launch with existing LaunchAgent daemon already running

```
1. User double-clicks autonomOS.app
2. Splash: "Starting autonomOS…"
3. Behind the splash:
     a. start-server flow → reads pid file → live owner detected
     b. Desktop switches to thin-client mode
     c. "This Mac" Connection synthesized with the daemon's port
        and the existing token from ~/.autonomos/token
4. Splash transitions directly to the dashboard (no child spawn)
5. Sidebar shows "This Mac (Always-on)"
```

### Launch with a saved remote Connection (e.g., forge)

```
1. User double-clicks autonomOS.app
2. Splash: "Starting autonomOS…"
3. Behind the splash:
     a. start-server flow checks: do we have a Built-in OR Server preference
        configured for this user's `defaultConnectionId`?
     b. If defaultConnectionId points at a remote → open that Connection,
        DON'T spawn a Built-in server (the user has explicitly chosen remote
        as their default)
     c. If defaultConnectionId points at "local" or is null → run the
        Built-in flow (same as first-launch)
4. Splash transitions to the dashboard for the active Connection
```

### Quit while agents are running (Built-in mode only)

When the user invokes ⌘Q or Dock → Quit on a Built-in-mode window with active agent sessions:

```
┌────────────────────────────────────────────────────────────┐
│  Quit autonomOS?                                           │
│                                                            │
│  Agents will pause when you close autonomOS. They'll       │
│  resume when you reopen the app.                           │
│                                                            │
│  Want them to keep running in the background even when     │
│  this app is closed?                                       │
│                                                            │
│  [ Make autonomOS Always-on ]  [ Quit anyway ]  [ Cancel ] │
└────────────────────────────────────────────────────────────┘
```

- **"Make autonomOS Always-on"** → migration flow (below). After migration completes, the Desktop quits cleanly; agents continue under the LaunchAgent.
- **"Quit anyway"** → standard shutdown. Server child gets SIGTERM. Agents pause; state persists on disk.
- **"Cancel"** → return to the app, no action.

The prompt is suppressed if there are NO running agents (nothing to lose). It's also suppressed in Always-on mode (the daemon already persists).

### Migration: Built-in → Always-on

Triggered from either the quit-time prompt OR Settings → "Keep autonomOS running in the background" toggle.

```
1. Show in-app progress dialog: "Setting up background mode…"
2. Desktop's main process invokes the bundled `autonomos install-service`
   command via child_process, capturing stdout/stderr to display progress.
3. install-service:
     a. Detects an existing pid-file owner (us, the Built-in child)
     b. Sends graceful-shutdown IPC to that child via a dedicated
        `~/.autonomos/migrate.sock` Unix socket (Phase 1B.2.5.1: new contract)
     c. Waits for the child to release the pid file (max 5s)
     d. Installs the LaunchAgent / systemd-user service
     e. launchctl bootstrap → LaunchAgent starts the daemon
     f. New daemon claims the pid file
4. Progress dialog → "Done. autonomOS is now running in the background."
5. Desktop reloads its "This Mac" Connection from the new pid file,
   sidebar label updates to "Always-on."
6. (If from quit-time prompt) Desktop quits; daemon keeps running.
   (If from Settings toggle) Desktop stays open, reconnected as thin
   client.
```

### Migration: Always-on → Built-in

Settings toggle → OFF.

```
1. Show: "Stop running autonomOS in the background?"
   ☐ Stop background mode and revert to Built-in (agents will pause
     when this app closes)
   [ Confirm ] [ Cancel ]
2. On confirm:
     a. invoke `autonomos uninstall-service`
     b. launchctl bootout removes the LaunchAgent; daemon receives SIGTERM
     c. pid file released
     d. Desktop spawns Built-in server child to take over
3. Sidebar label "This Mac (Always-on)" → "This Mac (Built-in)"
```

## Module additions / changes

### Server side

| File | Change |
|---|---|
| `packages/server/src/pid-file.ts` | Add `acquireOwnership(): Promise<{ status: "acquired" \| "already-running"; owner?: PidFileContents }>`. Uses tmp lock file with O_EXCL semantics. |
| `packages/server/src/run.ts` | Call `acquireOwnership()` before binding. If `already-running` → emit JSON `{ alreadyRunning: true, port, pid }` to stdout and exit 0. (CLI consumers parse this.) |
| `packages/server/src/migrate.ts` *(new)* | Sets up `~/.autonomos/migrate.sock` listening for graceful-shutdown IPC. Server quits cleanly on receipt. |

### CLI changes

| File | Change |
|---|---|
| `packages/cli/src/commands/install-service.ts` | Check pid-file ownership first. If a process holds it: send graceful-shutdown via migrate.sock with 5s timeout, then proceed. Print "A server is already running (pid M, in autonomOS.app). Will hand off…" Show progress. |
| `packages/cli/src/commands/start.ts` | Check pid-file. If `already-running` → print friendly message + exit 0. |
| `packages/cli/src/commands/uninstall-service.ts` | After uninstall, Desktop's reconnection logic re-spawns Built-in. |

### Desktop changes

| File | Change |
|---|---|
| `packages/app/src/main/server-supervisor.ts` *(new — resurrected from PR #172)* | Spawns the bundled `autonomos-server` from `resources/server/`. Wires AUTONOMOS_READY parse, SIGTERM on shutdown. Adds `acquireOrConnect(): Promise<{ mode: "built-in"; child: ChildProcess; port: number } \| { mode: "thin-client"; port: number }>`. |
| `packages/app/src/main/main.ts` | First-launch path now goes through `acquireOrConnect()`. The result determines splash duration + which mode the sidebar reports. |
| `packages/app/src/renderer/Splash.tsx` *(new)* | 600x400 centered window. autonomOS icon + "Starting autonomOS…". Shown for ≥500ms (no flicker) and ≤8s (failure timeout → show error). |
| `packages/app/src/renderer/Welcome.tsx` | Repurposed: this is now the "Add another Connection" screen, opened from sidebar + button. Not shown at first launch. |
| `packages/app/src/renderer/Settings.tsx` *(new)* | Settings panel with the "Keep autonomOS running in the background" toggle + other prefs. Accessed from menu bar or app menu. |
| `packages/app/src/renderer/QuitPrompt.tsx` *(new)* | Quit-time dialog. Triggered by Electron's `before-quit` when running agents > 0 in Built-in mode. |
| `packages/app/src/main/migrate.ts` *(new)* | In-app migration controller. Spawns `autonomos install-service` / `uninstall-service` as child processes, parses their JSON progress output, drives the progress dialog. |
| `packages/app/src/shared/api.ts` | Add `settings.toggleBackgroundMode(enabled: boolean): Promise<MigrateResult>` and `agents.runningCount(): Promise<number>` to the AutonomosAPI surface. |

### Connection sidebar updates

The sidebar from Phase 1B.2 stays. Updates:

- The "This Mac" connection (synthesized, never stored in connections.json) is always pinned at the top.
- Subtitle reflects mode: "Built-in" (Desktop owns process) or "Always-on" (LaunchAgent-supervised).
- The Connection record's `type` becomes one of: `"built-in"`, `"local-persistent"`, `"remote"`. The Desktop infers the first two by reading the pid file; only `remote` is user-entered.
- Color-coded mode badge: gray ("Built-in" — works only when this app is open), green ("Always-on" — persistent), blue ("Remote").

## Vocabulary

| Concept | UI label | Code/CLI label |
|---|---|---|
| Server spawned by Desktop | "Built-in" | `mode: "built-in"` |
| LaunchAgent-supervised local | "Always-on" | `mode: "local-persistent"` |
| HTTP to another machine | "Remote" or the connection name | `mode: "remote"` |
| The combined Always-on + Remote category | "Server" | `Connection.type === "server"` (rare; mostly we keep them distinct internally) |

Never expose in UI copy: "embedded", "daemon", "launchd", "systemd", "thin client", "host", "process", "child process".

## Phase plan

Sub-phases that fold into PR #173 OR follow-up PRs:

| Sub-phase | What | PR target |
|---|---|---|
| **1B.2.8** | Server-side `acquireOwnership()` + atomic pid claim + migrate.sock | #173 (server changes) |
| **1B.2.9** | CLI install-service / start updates for the new contract | #173 |
| **1B.2.10** | Desktop `server-supervisor.ts` (resurrected from PR #172) + acquire-or-connect | New PR |
| **1B.2.11** | Splash screen + first-launch UX | New PR |
| **1B.2.12** | Settings panel + Background toggle + migration controller | New PR |
| **1B.2.13** | Quit-time prompt | New PR |
| **1B.2.14** | Sidebar label updates + mode badges | New PR |

Total estimate: ~5-7 days across all sub-phases. Each is shippable independently.

## What this does NOT change

- Phase 1B.2's webview drag fix → unchanged
- Phase 1B.2's multi-window architecture → unchanged
- Phase 1B.2's quit-cleanup (VS Code pattern) → unchanged
- Phase 1B.2's CSS injection for traffic-light integration → unchanged
- Phase 1B.2's auth via cookie + bearer token → unchanged
- All audit fixes from earlier in Phase 1B.2 → unchanged

ADR-029 is **additive** to Phase 1B.2's work, not a rewrite.

## Open questions deferred

These are decisions we don't need to make now but should track for future sub-phases:

1. **Token sharing between Built-in and Always-on.** If the user migrates Built-in → Always-on, do we reuse the existing `~/.autonomos/token` or generate a new one? My lean: reuse, to preserve any saved Connection entries that used the old token. Test in 1B.2.10.
2. **Port stability.** Built-in spawns with `--port=0` (kernel-assigned). LaunchAgent uses a fixed port (5050 default). Migration changes the port — the Desktop must update its "This Mac" Connection record automatically. Handled in 1B.2.12.
3. **Background mode availability on Linux.** systemd-user setup is more variable than launchd. The "Background" toggle should be disabled on Linux distros where systemd-user isn't available, with a tooltip explaining why.
4. **Server-side upgrade flow.** `autonomos upgrade` for an Always-on server is straightforward. For a Built-in server, the Desktop's bundled binary IS the version — desktop-updater (Phase 1B.4) handles it. Document the difference in the sub-phase 1B.4 work.

## References

- [ADR-028](../DECISIONS.md#adr-028-desktop-app-is-a-thin-client-not-a-server) — the prior decision this ADR partially supersedes
- [ADR-029](../DECISIONS.md#adr-029-desktop-embeds-built-in-server-reverses-part-of-adr-028) — this ADR
- [`desktop-as-thin-client.md`](desktop-as-thin-client.md) — Phase 1B.2 design doc (still the design for "Server" mode)
- [`packages/server/src/pid-file.ts`](../../packages/server/src/pid-file.ts) — pid file schema (already shipping)
- [Docker Desktop architecture](https://collabnix.com/docs/docker-desktop/architecture-of-docker-desktop-for-mac-18702/) — the inspiration for the "Built-in everything, install-service as upgrade" pattern
- [Postgres.app GitHub](https://github.com/PostgresApp/PostgresApp) — same pattern for a different domain
