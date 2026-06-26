# autonomOS — Desktop & Distribution Plan

> Consolidated design from the desktop-app initiative. Single source of truth.
> Last consolidated: 2026-05-12.

---

## Executive Summary

We are repackaging autonomOS into two distributions that share ~85% of their code:

1. **autonomOS Server** — a static binary you install on a Linux box / homelab / Mac. Persistent daemon. Web-installable. Replaces the current `git clone + make prod + pm2` flow.
2. **autonomOS Desktop** — a native Electron app for macOS (flagship), Linux, eventually Windows. Embeds the same server as a child process. Polished, cmux-feel UX. Auto-updates atomically.

**Flagship**: autonomOS Desktop. **Ships first**: autonomOS Server (because it's mostly already built).

---

## Locked Decisions

| | Decision |
|---|---|
| **Framework** | Electron (cross-platform, ~85% code reuse with web-server, can deliver cmux-feel polish) |
| **Distributions** | Two: autonomOS Server (binary) + autonomOS Desktop (DMG/installer) |
| **Flagship positioning** | Desktop is the headline; Server is "advanced users / homelab" |
| **Experiential north star** | cmux — feel + packaging (vertical-tab sidebar, native polish, GPU terminals, DMG distribution) |
| **Server persistence** | Pattern 1: LaunchAgent (mac) / systemd-user (linux), **user-scope default** (no sudo) |
| **Desktop persistence** | L1: Pattern 2 + state recovery via `claude --resume`. App quits → agents stop → state preserved → resume on reopen. |
| **Server distribution** | Single static binary via `bun build --compile`. Install via `curl autonomos.dev/install.sh \| bash` or `brew install autonomos`. |
| **Subcommands** | `autonomos-server start \| stop \| status \| upgrade \| install-service \| uninstall-service` |
| **Desktop CLI shim** | **None.** Desktop launches via Spotlight/Finder only. (autonomOS isn't directory-scoped like VS Code, so no use case justifies it.) |
| **Brand-level names** | **autonomOS App** (desktop) · **autonomOS Server** (headless) |
| **Filesystem artifacts** | `/Applications/autonomOS.app` (App) · `/usr/local/bin/autonomos-server` (Server CLI) |
| **Server interaction surface** | Hosts webserver, accessible via URL+port, network-reachable |
| **App interaction surface** | Native window only, private localhost port, never exposed |
| **Brew distribution** | `brew install --cask autonomos-app` (App via cask) · `brew install autonomos-server` (Server via formula). No CLI shim collision since they live in different parts of the filesystem. |
| **Internal packages** | `packages/server/` (runtime) · `packages/cli/` (Server CLI wrapper) · `packages/app/` (Electron shell) |
| **Desktop upgrade** | `electron-updater` against GitHub Releases. Atomic shell+server upgrade. Corner toast UX with agent-reassuring copy. |
| **Server upgrade** | Two entry points, one implementation: `autonomos upgrade` CLI AND web-GUI button. Both call `POST /api/system/upgrade`. |
| **App Store path** | Preserved as future option (L1 + Pattern 2 + state recovery is App Store-compatible) |
| **Code signing** | Apple Developer Program $99/yr accepted. Windows EV cert deferred until Windows is critical. |
| **Release pipeline** | One CI tag → matrix build → publishes all artifacts to one GitHub Releases entry |

---

## Reference Architecture

Maximum shared code. Both distributions ship the exact same `autonomos` binary internally.

```
┌─────────────────────────────────────────────────────────────┐
│  packages/core/         Shared types, constants, utilities   │
│  packages/server/       Hono + bun server core               │
│                         Hook relay · gateway · MCP           │
│                         Schedules · agent lifecycle          │
│                         L1 state recovery (claude --resume)  │
│  packages/dashboard/    React + Vite UI                      │
│                         Detects window.autonomosShell        │
│                         Routes upgrade button accordingly    │
│                                                               │
│        ↑↑↑  shared by both distributions  ↑↑↑               │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
   ┌────────────────────────┐    ┌──────────────────────────┐
   │  packages/cli/  (NEW)  │    │  packages/desktop/ (NEW) │
   │  ──────────────────    │    │  ──────────────────      │
   │  • bun build --compile │    │  • Electron main process │
   │  • Subcommand parser   │    │  • spawns `autonomos     │
   │  • install-service     │    │    --embedded` as child  │
   │  • launchd/systemd     │    │  • native bridge,        │
   │    plist templates     │    │    menus, tray, badge    │
   │  • install.sh script   │    │  • electron-updater /    │
   │                        │    │    GitHub Releases       │
   │  ~500 LOC              │    │  ~1500–2500 LOC          │
   └────────────────────────┘    └──────────────────────────┘
   "autonomOS Server"             "autonomOS Desktop"
   binary install                 DMG / installer
   Pattern 1 persistent daemon    L1 (Pattern 2 + resume)
```

---

## The Two Distributions, Side by Side

### autonomOS Server

| | |
|---|---|
| **Audience** | Power users, homelabs, dev boxes, shared servers |
| **Install** | `curl -fsSL autonomos.dev/install.sh \| bash` or `brew install autonomos` |
| **Where it runs** | Linux box, Mac, NAS — any always-on machine |
| **Daemon model** | Pattern 1 — LaunchAgent / systemd-user, persistent, survives logout/reboot |
| **Access** | Browser PWA pointed at `http://that-machine:3100` |
| **Upgrade** | CLI: `autonomos upgrade` · Web GUI: Settings → Upgrade button (same backend) |
| **Code signing** | Not needed (CLI binary) |

### autonomOS Desktop

| | |
|---|---|
| **Audience** | Flagship — anyone who wants a polished native experience |
| **Install** | Drag DMG to /Applications (mac) · MSI (win, later) · AppImage (linux, later) |
| **Where it runs** | The user's laptop |
| **Daemon model** | L1 — Pattern 2 + state recovery via `claude --resume`. Quit app = agents stop. Reopen = state restored. |
| **Access** | Native Electron window, vertical-tab sidebar, GPU terminals |
| **Upgrade** | electron-updater corner toast: "New version of autonomOS is ready. Your agents will resume after restart." `[Restart] [✕]` |
| **Code signing** | Apple Developer ID required ($99/yr) |

---

## Phase Plan (Desktop-First)

```
Phase 1A.1   Binary buildable (truly minimal)        ~2-3 days   ← BUILD FIRST
             ──────────────────────────────────────
             • bun build --compile pipeline
             • Headless server mode flag
             • Dashboard assets embedded in binary
             • Binary runs the server when invoked with argv flags
               (--port, --embedded; NO subcommand framework)
             • Existing make prod / pm2 deployment unchanged

Phase 1B     autonomOS Desktop (FLAGSHIP)             ~3-6 weeks  ← FOCUS
             ──────────────────────────────────────
             packages/desktop/ Electron app
             Spawns the Phase 1A.1 binary as embedded child
             Electron supervises it (no pm2/launchd needed for Desktop)
             Native menus, vertical-tab sidebar, dock badge, tray
             Apple Developer signing + notarization setup
             electron-updater + corner toast upgrade UX
             L1 state recovery wired (claude --resume on launch)
             DMG distribution + Homebrew cask
             ~3-5 PRs

Phase 1C     Server distribution polish              ~2-3 weeks   ← REAL WORK
             ──────────────────────────────────────
             Subcommand framework: autonomos status | stop | upgrade |
                                   install-service | uninstall-service |
                                   migrate-from-pm2
             install.sh web installer
             SUPERVISION: launchd LaunchAgent (mac) + systemd-user (linux),
                user-scope default, --system flag for opt-in
                + loginctl enable-linger handling on Linux
                + embedded plist/unit templates (Tailscale pattern, ~250 LOC TS)
             pm2 migration: HARD CUTOVER with built-in migration on upgrade
                — `autonomos upgrade` from v1.x detects pm2, stops it,
                  installs new supervisor, verifies. Single-shot, no
                  dual-supervisor codepath. Clean end state.
             POST /api/system/upgrade endpoint
             Dashboard "Upgrade" button (server mode)
             GitHub Releases pipeline for binary distribution
             Existing users get clean backward-compat migration path
             ~500-700 LOC total (supervision + migration + tests)

Phase 2+     Deferred (in priority order, do when demand emerges)
             ──────────────────────────────────────
             • Windows distribution (Electron build + EV cert)
             • Linux desktop distribution (AppImage)
             • Mac App Store version (if ever)
             • Remote-connect for desktop (SSH tunneling)
             • Multi-instance / multi-host UI
             • SMAppService L2 persistence (only if real demand)

Permanently rejected (not part of this plan)
             ──────────────────────────────────────
             • npm wrapper (npx @autonomos/server) — purely additive, not needed
             • Mesh / control-plane / federation model
             • Cloud-burst architecture (Cursor 3 style)
             • Mac App Store version that compromises functionality
```

**Rationale for Desktop-first ordering:**
- Phase 1A.1 (binary buildable) is the only true prerequisite for Phase 1B
- No CLI subcommand framework needed in 1A.1 (Caddy-style: binary IS the server)
- No supervision mechanism needed in 1A.1 or 1B (Electron supervises in 1B)
- Phase 1C polish only matters when onboarding external web-server users
- Terry is the only current web-server user, content with current pm2 install
- Building the flagship first matches energy + ships shareable artifact sooner
- The architecture is unchanged; only the sequencing differs

**Deferred-but-not-blocked decisions:**
- Supervision mechanism (pm2 vs launchd/systemd-user) — decided in Phase 1C
- Server distribution audience (external users) — addressed in Phase 1C

---

## Phase 1A — Detailed Scope

This is what we build first. **Goal**: ship a polished server distribution that replaces the current `git clone + make prod` install with `curl install.sh | bash`.

### New files

```
packages/cli/                          NEW
├── src/
│   ├── index.ts                       Subcommand parser entry
│   ├── commands/start.ts              Bootstraps the server in user session
│   ├── commands/stop.ts               Graceful shutdown
│   ├── commands/status.ts             Daemon health, version, port
│   ├── commands/upgrade.ts            Fetch latest binary, verify, replace, restart
│   ├── commands/install-service.ts    Writes plist/unit
│   └── commands/uninstall-service.ts  Removes plist/unit, stops daemon
├── templates/
│   ├── launchd.plist.tmpl             User-scope LaunchAgent
│   └── systemd-user.service.tmpl
└── build/build-binary.ts              bun build --compile orchestration

scripts/
├── install.sh                         Detects arch, downloads release artifact,
│                                       places binary at /usr/local/bin/autonomos,
│                                       runs `autonomos install-service`
└── release-build.sh                   CI orchestration for matrix builds

.github/workflows/release.yml          NEW: matrix build on tag push
```

### Modified files

```
packages/server/
├── src/index.ts                       Add headless flag, accept dynamic port
├── src/api/system.ts                  NEW: GET /api/system/version,
│                                       POST /api/system/upgrade
└── (build config)                     Embed dashboard build into compiled binary

packages/dashboard/
└── src/components/Settings/About.tsx  NEW: version display + "Check for updates"
                                       + upgrade button (calls /api/system/upgrade
                                       in server mode)

package.json (root)                    Add `bin` field, `publishConfig`, build scripts
```

### Build pipeline

```yaml
On tag push (v*):
  jobs:
    matrix:
      - darwin-arm64
      - darwin-x64
      - linux-x64
      - linux-arm64
    
    steps:
      1. bun install
      2. cd packages/dashboard && bun run build
      3. cd packages/cli && bun run build-binary  # invokes bun build --compile
      4. Upload binary to GitHub Release (one per platform)
      5. Generate latest.json metadata
```

### Test plan

- Fresh-install on clean macOS VM via `curl install.sh | bash`
- Fresh-install on clean Ubuntu VM via same
- Verify daemon starts at user login (logout/login test)
- Verify dashboard reachable at http://localhost:3100 after install
- Verify `autonomos status` returns running daemon info
- Verify `autonomos upgrade` from v0.1.0 → v0.1.1 (test release)
- Verify web-GUI upgrade button performs same upgrade
- Verify daemon restart preserves agent state on disk
- Verify `autonomos uninstall-service` cleanly removes everything

### Out of scope for Phase 1A

- Electron app (Phase 1B)
- Native menus, dock badge, tray (Phase 1B)
- Code signing (not needed for CLI binary)
- Windows support (Phase 2)
- System-scope LaunchDaemon (Phase 2 — `--system` flag stub only)

---

## Non-blocking queue (Phase 1B shape)

Decisions still to be made before Phase 1B starts. None of these block Phase 1A.

### Positioning sentences

```
autonomOS Desktop
  For:        ___________________________________
  Install:    ___________________________________
  Use it to:  ___________________________________

autonomOS Server
  For:        ___________________________________
  Install:    ___________________________________
  Use it to:  ___________________________________
```

### First-run UX for desktop app

What the user sees on first open: layout, prominent CTA, onboarding tone.

### Window/pane/tab model for desktop app

How agents are arranged on screen. cmux uses vertical-tab sidebar with panes inside.

### Upgrade indicator placement

VSCode-style corner toast locked. Specific position + dismissal behavior to refine in Phase 1B.

---

## Cross-track effects

This plan absorbs or reshapes several previously-parked tracks:

| Previously parked | Now becomes |
|---|---|
| InstallUX `npx autonomos` | Phase 1A's install.sh + static binary (npm publish dropped) |
| PM2 → npx migration | Phase 1A's launchd/systemd-user replacement |
| Upgrade UX Tier 1 | Split: Phase 1A web-GUI button + Phase 1B electron-updater |
| Multi-version concurrency concern | Solved structurally — each user picks one distribution |
| Mesh / mission control / cloud burst | Permanently rejected |
| Remote-connect for desktop | Deferred to Phase 2+ |
