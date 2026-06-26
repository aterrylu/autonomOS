# Phase 1C — autonomOS Server Distribution (Sketch)

> Polish the server CLI for external users. Hard cutover from pm2 with built-in
> migration. SKETCH, not a full proposal.
>
> Scope: ~400-500 LOC. ~2-3 weeks. Two or three PRs likely.

---

## Goal

Replace the current `git clone + make prod + pm2` install flow with a polished
single-command install:

```
$ curl -fsSL autonomos.dev/install.sh | bash
# → Downloads autonomos-server binary for your platform
# → Places at /usr/local/bin/autonomos-server
# → Writes LaunchAgent (mac) or systemd-user unit (linux)
# → Starts daemon
# → Prints "✓ Installed. Open http://localhost:3100"

$ autonomos-server status
✓ Running · port=3100 · pid=12345 · uptime=2h · version=0.2.0

$ autonomos-server upgrade
→ Downloading v0.2.1 from GitHub Releases...
→ Verifying signature...
→ Restarting daemon...
✓ Upgraded to v0.2.1
```

---

## What gets built

### New package: `packages/cli/`

```
packages/cli/
├── src/
│   ├── index.ts              Subcommand parser entry (Node's util.parseArgs)
│   ├── commands/
│   │   ├── start.ts          Spawns daemon (or attaches to existing)
│   │   ├── stop.ts           Graceful shutdown via SIGTERM
│   │   ├── status.ts         Health check, version, uptime, port
│   │   ├── upgrade.ts        Fetch + verify + replace binary + restart
│   │   ├── install-service.ts Writes plist/unit + starts daemon
│   │   ├── uninstall-service.ts Stops + removes plist/unit
│   │   └── migrate-from-pm2.ts pm2 detect + stop + unstartup + reinstall
│   ├── supervision/
│   │   ├── launchd.ts        Mac: writes ~/Library/LaunchAgents/com.autonomos.agent.plist
│   │   ├── systemd-user.ts   Linux: writes ~/.config/systemd/user/autonomos.service
│   │   │                              + runs loginctl enable-linger
│   │   └── templates.ts      Embedded plist + unit string constants (Tailscale pattern)
│   └── github-releases.ts    Fetches latest.json, signature verification

packages/server/                       MODIFIED
└── src/api/system.ts                  NEW: POST /api/system/upgrade endpoint
                                       (used by both CLI command AND web GUI)

packages/dashboard/                    MODIFIED
└── src/components/Settings/About.tsx  NEW: version display, "Check for updates",
                                       "Upgrade" button → POST /api/system/upgrade

scripts/
└── install.sh                         NEW: web installer
                                       Detects platform, downloads release asset,
                                       installs to /usr/local/bin/,
                                       runs `autonomos-server install-service`
```

### Distribution

- GitHub Releases workflow expanded to publish autonomos-server binaries
  (currently Phase 1A.1 builds them locally only)
- Homebrew formula in `homebrew-autonomos` tap (sibling repo)
- `install.sh` hosted on autonomos.dev

---

## Sub-phase breakdown (probable PR sequence)

| | Sub-phase | Scope | LOC est. |
|---|---|---|---|
| **1C.1** | CLI subcommand framework | `packages/cli/` scaffold, subcommand parser, start/stop/status commands, talks to running daemon over HTTP | ~150-200 |
| **1C.2** | Supervision install | install-service / uninstall-service commands, launchd + systemd-user templates, loginctl enable-linger handling | ~150-200 |
| **1C.3** | install.sh + GitHub Releases pipeline | Web installer script, CI matrix builds, release tagging, signature generation | mostly config |
| **1C.4** | Self-upgrade + pm2 migration | upgrade command, /api/system/upgrade endpoint, web-GUI upgrade button, migrate-from-pm2 logic, hard cutover on upgrade | ~150-200 |

---

## Decisions already locked

- Single static binary (`bun build --compile` from Phase 1A.1)
- Supervision: launchd LaunchAgent (mac) + systemd-user (linux), user-scope default
- `--system` flag opts into system-scope (LaunchDaemon / systemd-system)
- Templates embedded as TypeScript string constants (Tailscale pattern)
- Binary name: `autonomos-server`
- Upgrade flow: explicit CLI command + web-GUI button + passive boot notification
- pm2 migration: HARD CUTOVER with built-in migration during `autonomos-server upgrade`
- npm wrapper: NOT in scope (intentionally dropped)
- Windows: deferred to Phase 2+

---

## Open decisions before 1C starts

### install.sh user experience

Specifically what the install script prints, prompts for, and what shows up on
first install. Worth one round with Terry before implementing.

### Upgrade rollback policy

Keep `autonomos-server.previous` for one cycle and have a `--rollback` flag,
or just trust forward-only upgrades? Tailscale does forward-only; most others
keep a previous version for safety. Terry to decide.

### Telemetry / opt-in usage reporting

Anonymous version + OS reporting on upgrade? Useful for prioritizing platform
support. Some products (Tailscale, Caddy) do this opt-in; others don't.
Terry to decide. Default: NO telemetry unless explicitly opted in.

### homebrew-autonomos tap branding

Tap name (`homebrew-autonomos` vs `homebrew-tools` vs `autonomos/tap`), README
copy, support promise. Lightweight but worth one decision pass.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| pm2 migration breaks for some users' specific pm2 setups | Medium | Detect+abort with clear error message rather than blindly migrate; provide manual migration docs |
| systemd-user without loginctl enable-linger → daemon dies on logout | High if forgotten | Hard-code into install-service command |
| First Apple Developer signing setup adds days of yak shaving | Medium | Schedule early in 1C; doesn't block 1C.1-1C.3 |
| Existing users on weird OS variants (older Ubuntu, custom Mac setups) | Medium | Best-effort support, fall back to "compile from source" docs |

---

## After Phase 1C lands

The product is fully shippable in both distributions. Subsequent work is
all Phase 2+ (Windows, Linux desktop, App Store, remote-connect, etc).
