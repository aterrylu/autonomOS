# Phase 1B — autonomOS App (Sketch)

> The flagship. Native Electron desktop app wrapping the Phase 1A.1 binary.
> This is a SKETCH, not a full proposal — details fill in as we approach 1B.
>
> Scope: ~1500-2500 LOC. ~3-6 weeks. Multiple PRs likely.

---

## Goal

Ship a polished native Mac app (.dmg installable) that wraps the autonomos-server
binary, delivers a cmux-feel UX, auto-updates atomically, and survives App Store
compatibility constraints.

```
User experience after 1B ships:
  1. Download autonomOS.dmg from autonomos.dev or `brew install --cask autonomos-app`
  2. Drag autonomOS.app to /Applications
  3. Open via Spotlight → native window with vertical-tab sidebar
  4. Spawn agents, manage sessions, all current dashboard functionality
  5. Cmd-Q → graceful shutdown, agent state preserved
  6. Reopen → state restored via claude --resume
  7. Tiny corner toast on new release → click to update atomically
```

---

## What gets built

### New package: `packages/app/`

```
packages/app/
├── src/
│   ├── main.ts              Electron main process entry
│   ├── server-supervisor.ts Spawns autonomos-server binary as child,
│   │                         reads AUTONOMOS_READY signal, manages lifecycle
│   ├── window-manager.ts    BrowserWindow creation, vibrancy, vertical-tab layout
│   ├── menu.ts              Native menu (App, File, Edit, View, Window, Help)
│   ├── tray.ts              Dock badge, system tray icon
│   ├── preload.ts           window.autonomosShell bridge (notifications,
│   │                         openExternal, native dialogs, etc.)
│   ├── updater.ts           electron-updater integration, corner toast UI
│   ├── state-recovery.ts    L1 implementation — detect exited agents on
│   │                         launch, re-spawn via claude --resume
│   └── ipc.ts               Main↔renderer communication
├── resources/
│   ├── icon.icns / icon.ico Standard app icons
│   └── server-binary/       The autonomos-server binary, embedded at build time
├── build/
│   ├── electron-builder.json Build + signing + cask config
│   └── notarize.js           Apple notarization automation
└── package.json

packages/dashboard/                  MODIFIED
└── src/native-bridge.ts             NEW: detects window.autonomosShell,
                                     routes upgrade button + notifications +
                                     external links through native APIs
```

### CI / build pipeline

- `.github/workflows/release-app.yml` — matrix build on tag push:
  darwin-arm64 + darwin-x64 DMGs, signed + notarized, published to GitHub Releases
- Apple Developer ID signing certificates managed via GitHub Secrets
- electron-updater consumes the `latest-mac.yml` metadata GitHub Releases emits

---

## Sub-phase breakdown (probable PR sequence)

| | Sub-phase | Scope | LOC est. |
|---|---|---|---|
| **1B.1** | Electron shell that spawns and connects | `main.ts` + `server-supervisor.ts` + minimal `window-manager.ts`. Webview loads dashboard from spawned child. Cmd-Q gracefully shuts down. | ~400-600 |
| **1B.2** | Native UX polish | menu, tray, dock badge, vibrancy, vertical-tab sidebar arrangement of existing dashboard layout, keyboard shortcuts (Cmd-N/T/W/1-9), `window.autonomosShell` preload bridge | ~500-800 |
| **1B.3** | State recovery (L1) | `state-recovery.ts` — on launch, scan ~/.autonomos/sessions for exited agents, offer to resume via claude --resume | ~200-300 |
| **1B.4** | Auto-update | `updater.ts` — electron-updater hookup, corner toast component in dashboard, atomic shell+server upgrade flow | ~300-400 |
| **1B.5** | Signing + packaging + first DMG release | Apple Developer Program enrollment, certificate setup, electron-builder config, notarization workflow, first signed DMG | mostly config |

Each sub-phase a separate PR. 1B.1 unblocks 1B.2-1B.4 to run in parallel if desired.

---

## Decisions already locked (no rework)

- Framework: Electron
- Persistence model: L1 (Pattern 2 + state recovery)
- Upgrade UX: corner toast, "Your agents will resume after restart."
- App Store path preserved (architecture is sandbox-compatible)
- Signing: Apple Developer ID, $99/yr accepted
- Brand name: autonomOS.app in /Applications/
- Brew distribution: cask via `homebrew-autonomos` tap
- No CLI shim (no `autonomos` in PATH from app install)
- Bundled server is the same binary from Phase 1A.1

---

## Open decisions / contributions needed before 1B starts

### First-run UX

What does the user see the first time they open autonomOS.app?
cmux opens to a sidebar + empty pane + "+ New session" affordance. We have prepared
slots for this in the design notes. Terry to fill before 1B.1.

### Window/pane/tab model

How agents arrange on screen. Current dashboard uses binary-tree split panes.
cmux uses vertical-tab sidebar. Need to decide composition. Terry to sketch.

### Positioning sentences

For website + install copy. Slots prepared. Terry to fill.

### Upgrade toast position/copy refinement

Bottom-right corner is locked. Exact dismissal behavior, animation, copy can
be refined when 1B.4 starts.

### `window.autonomosShell` API surface

The native bridge that the dashboard checks for. Minimum: notify, openExternal,
showItemInFolder, setBadge, openDevTools. Terry can extend.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| node-pty's native bindings don't bundle cleanly inside Electron | Medium | Test in 1B.1; fallback is to ship node-pty as a sidecar |
| Vertical-tab layout reshuffles existing dashboard packages/dashboard layout system invasively | Medium | Build layout swap as opt-in mode first, then make default |
| Apple notarization rejection on first submission (unusual entitlements) | Low | Submit early; iterate based on rejection reasons |
| electron-builder + bun ecosystem friction | Low | Well-trodden path; electron-builder is mature |
| Code signing certificate setup wastes a day or two | Medium | Allow buffer; Apple's tooling is sometimes annoying |

---

## Phase 1A.1 ↔ Phase 1B integration contract

The contract is intentionally minimal — three things:

1. **Spawn**: `node dist/<platform>/index.js --port=0 --embedded`
2. **Discovery**: parse `AUTONOMOS_READY port=<N>` from child stdout
3. **Shutdown**: send SIGTERM; child exits cleanly within ~2s

**Readiness semantics** (from Phase 1A.1 PR review): the `AUTONOMOS_READY` signal
means "HTTP listener is accepting connections" — NOT "all agent state is fully
hydrated." Gateway init, agent resumption, and scheduler startup run in the same
tick but may finish slightly later. The dashboard already handles this gracefully
(agents stream in via WebSocket as they hydrate). Electron should load the
webview as soon as the signal fires; "fully populated UI" will lag by ~ms in
the typical case.

## After Phase 1B lands

Phase 1C (Server distribution polish) can begin. The autonomos-server binary
that ships INSIDE the Mac app is the same artifact that the standalone install.sh
will deliver. Two distributions, one binary, one source of truth.
