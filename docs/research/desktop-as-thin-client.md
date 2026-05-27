# Desktop as Thin Client — Phase 1B.2 Design

**Status:** Approved for implementation (2026-05-18)
**Replaces:** PR #172 (Phase 1B.1 embedded-server design)
**Decided by:** Terry + Feature Worker (CC session)

## TL;DR

The autonomOS Desktop app is a **pure thin Electron client**. It does NOT embed a server in production. It connects to one or more `autonomos-server` daemons — each running under launchd/systemd-user supervision, either on the user's Mac or on a remote machine (forge, VPS). Multiple connections are first-class, switchable like VS Code workspaces. The .dmg ships the server binary as bundled `extraResources` so the desktop can offer a "Set up local server on this Mac" flow that runs the existing `autonomos install-service` from Phase 1C.

## Why we're doing this

### The bug that triggered the rethink

PR #172 (Phase 1B.1) shipped a desktop app that spawned its own `autonomos-server` as an Electron child process. When the user opened the .app while a separately-installed `autonomos-server` was ALSO running (via launchd LaunchAgent from Phase 1C), both processes attached to the same `~/.autonomos/` state directory and the same PTY children. The result: corrupted session state, broken Claude Code agents.

The root cause was **conflating transport and supervision**. The desktop was supposed to be a UI; instead it was also competing to be a daemon supervisor.

### The n8n cautionary tale

n8n Desktop was sunset in May 2023. Stated reason: "focus and resources." Real reason visible in adoption data: **users who tried Desktop migrated to either n8n Cloud or n8n self-hosted within weeks.** Why?

- Workflows need to run in the background (overnight, on webhooks, scheduled)
- A desktop app that bundles a server is in conflict with this: close the app to save battery → workflows stop. Leave the app open → your Mac is now a server.
- Successful users always realized they needed a real server.

autonomOS has the same structural property: agents need to run while the user is asleep. The server has to live somewhere persistent. Terry's actual usage (deploying to forge + accessing via web) is structurally identical to n8n self-hosted.

### The validation

The "thin Electron client over an independently-supervised daemon" pattern is well-validated in production:

| App | Pattern | Notes |
|---|---|---|
| **MongoDB Compass** | Pure thin Electron over `mongod` | Canonical example. SSH tunneling first-class. |
| **Lens (Kubernetes IDE)** | Pure thin Electron over k8s clusters | Catalog/workspaces sidebar UX is the gold standard. |
| **Beekeeper Studio** | Pure thin Electron over RDBMS | Open-source reference. |
| **Open WebUI Desktop** | Electron + (local subprocess OR remote URL) | **Closest precedent for autonomOS.** Same product category (LLM tooling). |

The dominant pattern in the AI/agent space today is "bundled stack desktop" (AnythingLLM, LobeChat, Cmux). Those apps inherit n8n Desktop's structural problem. autonomOS going thin-client is **rare in the category but well-supported by the database-tooling lineage that survived**.

## Goals & non-goals

### Goals

1. The desktop app NEVER runs an embedded server in production. Always a client.
2. Users can connect to multiple servers (e.g., local Mac + remote forge) and switch between them like VS Code "Recent Folders."
3. First-launch UX offers a path for users with no server: "Set up local server on this Mac" runs the existing Phase 1C install flow (LaunchAgent + token).
4. Server install via `curl install.sh | sh` followed by paste-URL+token (or click `autonomos://` deep link) is the canonical "add remote server" flow.
5. Quitting the desktop app NEVER affects any server. Daemons stay running. Reconnect on next launch is instant.
6. Crashes of the server are surfaced clearly to the user with a "Reconnect" button.

### Non-goals

1. **No SSH-based remote install.** Don't make the desktop responsible for running install commands on a remote box. Users SSH there themselves and paste a one-liner.
2. **No bundled Python / heavy runtime.** Server bundle is already produced by Phase 1A.1; the desktop just copies it into `extraResources/server/` for the "Set up local server" path.
3. **No multi-server merged view.** Each connection is isolated. Don't try to render a global org chart spanning forge + local Mac in one pane — that's a future feature, not a 1B.2 concern.
4. **No mobile / iPad / browser-PWA variants.** Desktop only for this phase. The web UI served by the daemon already covers those surfaces via any browser.
5. **No menubar / tray app.** Desktop is a window app. Maybe later.
6. **No auto-update for the desktop itself.** Phase 1B.4 (electron-updater) is a separate phase.

## The mental model

The Server is the product. The Desktop is one of N clients to it.

```
autonomos-server (THE PRODUCT)
    The headless workhorse. Owns sessions, PTYs, state, hooks.
    Supervision: launchd LaunchAgent (Mac) / systemd-user (Linux)
    Ships as: tarball + install.sh, distributed via GitHub Releases
    Already shipped: Phase 1A.1 (bundleable) + Phase 1C (distribution polish)

Clients (any number, can coexist on the same host):
    1. Web Dashboard          — served BY the server at /
                                Use any browser. Already exists.
    2. autonomOS Desktop      — Electron .app. THIS PROJECT.
                                Thin client. Multi-connection.
    3. autonomos CLI          — `autonomos status`, `autonomos kill <id>`, etc.
                                HTTP client. Already shipped.
    4. MCP HTTP clients       — Claude Desktop, etc.
                                Already shipped via mcp.ts.
```

Compare this to MongoDB's lineup: `mongod` (product) + Compass (Electron client) + `mongo` CLI (client) + drivers (clients). Same shape.

## Type system

### `Connection`

The core type. Persisted to disk and shared between main and renderer.

```typescript
// packages/app/src/types/connection.ts
export interface Connection {
  /** Stable identifier. `local` is reserved for the local-mac connection. */
  id: string;

  /** Display name. For local: "Local Mac". For remote: user-provided or derived from hostname. */
  name: string;

  /** local = bundled server installed on this machine via LaunchAgent.
   *  remote = arbitrary URL we connect to with a bearer token. */
  type: "local" | "remote";

  /** Base URL of the autonomos-server. Includes scheme, host, port.
   *  E.g. "http://127.0.0.1:5050" or "https://forge.terrylu.cloud:7421" */
  url: string;

  /** ISO timestamp of last successful connection. Used for sorting recent. */
  lastConnectedAt?: string;
}
```

**Note:** the `Connection` interface deliberately does NOT carry the bearer token. Tokens are stored separately, keyed by `id`, encrypted via Electron `safeStorage` — see `main/config/tokens.ts`. This keeps tokens out of the main config file (which is meant to be human-readable / hand-editable) and lets us apply 0o600 permissions to the much smaller token file only.

Note: following Open WebUI Desktop's pattern, the **local connection is virtual** — synthesized at runtime from `localServerInfo` instead of stored in the array. This keeps "local is special" out of every iteration. The JSON config only stores remote connections.

### `AppConfig`

```typescript
// packages/app/src/types/config.ts
export interface AppConfig {
  /** Schema version for future migrations. Start at 1. */
  schemaVersion: 1;

  /** Remote connections. Local is synthesized; not stored here. */
  connections: Connection[];

  /** Which connection to auto-open on launch. null = show picker. */
  defaultConnectionId: string | null;

  /** Whether local server is installed (LaunchAgent exists, daemon health-checks).
   *  Source of truth for the daemon's port/pid/version is `~/.autonomos/autonomos.pid`
   *  (read fresh at every connect attempt — no cached port to go stale). */
  localServer: {
    installed: boolean;
  };

  /** UI preferences */
  ui: {
    sidebarWidth: number;
    theme: "system" | "light" | "dark";
  };
}
```

### `LocalServerInfo` (read from disk, not part of AppConfig)

**Correction post-design-audit:** the autonomos-server daemon ALREADY writes this file. It lives at `~/.autonomos/autonomos.pid` (see `packages/server/src/pid-file.ts`) and contains exactly `{ pid, port, version, startedAt }` — the same shape we need. No server-side changes required for Phase 1B.2. The desktop reads this file fresh at every connect attempt (no caching) so kernel-assigned-port restarts are handled gracefully.

## Persistence

| File | Where | Contents | Owner |
|---|---|---|---|
| `config.json` | `app.getPath("userData")/config.json` | AppConfig (no tokens) | Desktop app |
| `tokens.dat` | `app.getPath("userData")/tokens.dat` | Map<connectionId, encryptedToken> via Electron `safeStorage` | Desktop app |
| `autonomos.pid` | `~/.autonomos/autonomos.pid` | `{pid, port, version, startedAt}` — already shipping per `packages/server/src/pid-file.ts` | Server (no changes needed) |

**Atomic config writes**: borrow Open WebUI Desktop's pattern — `tmpfile → fsync → rename`, serialized via an in-process Promise lock. ~25 lines, skip `electron-store`.

**Token storage**: Electron's `safeStorage.encryptString()` uses Keychain on macOS, libsecret on Linux (when available), DPAPI on Windows. We write the encrypted blob to `tokens.dat`. If `safeStorage.isEncryptionAvailable()` returns false, we fall back to a plain JSON file with a clear warning in the UI ("Tokens are not encrypted on this system"). This is better than Open WebUI Desktop (which sniffs tokens out of webview localStorage into a mutable global).

## UX flows

### First launch (no `defaultConnectionId`, no local server installed)

```
┌──────────────────────────────────────────────────────────┐
│  Welcome to autonomOS                                    │
│                                                          │
│  autonomOS Desktop is a window into your autonomOS       │
│  Server. Connect to one to get started.                  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Set up local server on this Mac                   │ │
│  │  Installs autonomOS Server as a background service │ │
│  │  (launchd LaunchAgent). Keeps running when you     │ │
│  │  close this app.                                   │ │
│  │  [ Install ]                                       │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Connect to existing server                        │ │
│  │  Paste the URL + token from a server you've        │ │
│  │  already installed.                                │ │
│  │  URL:    [https://forge.terrylu.cloud:7421___]     │ │
│  │  Token:  [••••••••••••••••••••••]                  │ │
│  │  Name:   [forge (optional)]                        │ │
│  │  [ Connect ]                                       │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Don't have a server yet? Run on any Mac or Linux box:   │
│      curl -fsSL https://autonomos.cloud/install.sh | sh  │
└──────────────────────────────────────────────────────────┘
```

### "Set up local server" flow

1. Desktop reads bundled `Resources/server/` and runs the equivalent of `autonomos install-service`:
   - macOS: writes `~/Library/LaunchAgents/cloud.terrylu.autonomos.plist`, runs `launchctl bootstrap`
   - Linux: writes `~/.config/systemd/user/autonomos.service`, runs `systemctl --user enable --now`
2. Polls for `~/.autonomos/server-state.json` to appear (up to 30s, then surface error)
3. Reads the port + token from there, synthesizes the local connection
4. Sets `localServer.installed = true`, sets `defaultConnectionId = "local"`, persists
5. Loads `http://127.0.0.1:<port>/` in the BrowserWindow, sends the token cookie

### "Connect to existing server" flow

1. User pastes URL + token (+ optional name) in the form
2. Desktop validates by hitting an **authenticated** endpoint: `GET ${url}/api/system/version` with `Authorization: Bearer ${token}` and a 5s timeout
   - **Correction post-design-audit:** the doc originally said `/api/host`, but `/api/host` is auth-bypassed (used for unauth'd liveness probes). Using it would say "Connected!" with a bad token and fail on the next call. `/api/system/version` requires the token and returns `{version, platform, arch}`, so a 200 confirms both reachability AND token validity.
3. If 200: connection saved, becomes active
4. If 401: "Invalid token"
5. If timeout / connection refused: "Server unreachable. Check the URL and that the server is running."

### Deep link flow

User on a remote Linux box runs `curl ... install.sh | sh`. install.sh's last line of output prints:

```
✓ autonomOS Server v0.0.5 installed and running.
  URL:   https://93.184.216.34:7421
  Token: abc123def456...

  Add to autonomOS Desktop (click here from a Mac with the app installed):
  autonomos://connect?url=https%3A//93.184.216.34:7421&token=abc123def456&name=my-vps
```

The user clicks the link. macOS routes the URL to our `.app` via `LSSetDefaultHandlerForURLScheme` (registered via `app.setAsDefaultProtocolClient("autonomos")`). The desktop receives it as:

- **App not running**: argv contains the URL (Linux/Windows) OR `open-url` event fires (macOS, post-launch handoff). `app.requestSingleInstanceLock()` ensures one instance.
- **App already running**: `second-instance` event (Linux/Windows) or `open-url` event (macOS).

In both cases, the handler parses the URL, opens the Add Connection modal pre-filled with URL + token + name. User clicks "Connect" — same as the manual flow.

**Security mitigations (deep links are a phishing surface):**

A malicious webpage can fire `window.location = "autonomos://connect?url=evil.com&token=stolen"` and macOS will route it to autonomOS.app without a browser confirmation dialog (custom schemes don't prompt the way `mailto:` does). Without mitigation, a user clicking a hostile link could one-click-add an attacker-controlled "server" and then leak credentials through subsequent in-app actions. Required mitigations:

1. **The modal must pre-fill, never auto-save.** User must press the "Connect" button explicitly. No keyboard auto-focus on a default button that would submit on Enter.
2. **HTTP non-loopback URLs show a red warning banner.** `http://evil.com:7421` produces "This is an unencrypted connection over the public internet — only proceed if you trust this network." Loopback (`127.0.0.1`, `localhost`, `::1`) and HTTPS are quiet.
3. **Deep-linked connections never auto-become `defaultConnectionId`.** The user has to explicitly switch to a deep-link-originated connection from the sidebar. This means a one-click attack can add a connection but not immediately put the user inside the attacker's UI.
4. **Welcome-screen helper text explicitly tells users where deep links come from:** "Deep links should come from your terminal after running `install.sh`. If a webpage just opened this dialog, close it and report the page."
5. **Future hardening (post-1B.2, defer):** A `state` nonce mechanism — `install.sh` would write the URL to a local file the user clicks rather than embedding in the printed text. Or: rate-limit deep-link handling to one per N seconds. Not needed for 1B.2 given the single-user threat model.

### Switch connection

Sidebar shows all connections (local pinned at top, then remotes). Click switches the active `BrowserWindow` (or `WebContentsView` — see below). Per-connection `partition: persist:connection-${id}` on the session isolates cookies/auth state between servers (no leaking forge's session into local Mac's session). ⌘+1 through ⌘+9 switch by index.

**Correction post-design-audit:** earlier draft of this doc said `<webview>` tag. Chromium has deprecated `<webview>` for years and Electron docs steer toward `BrowserWindow` with `partition` (or the newer `WebContentsView`/`BaseWindow` API in Electron 30+). Open WebUI Desktop actually uses separate `BrowserWindow`s, not `<webview>` — I misread earlier. Switch to `BrowserWindow` (or `WebContentsView` if we want the inline-in-app feel). Cookies set via `session.fromPartition(\`persist:connection-${id}\`).cookies.set(...)`, NOT `session.defaultSession` (which would leak across connections).

### Server crash / disconnect

Desktop polls the server every 5s on the active connection (or relies on WebSocket close events when we ship those). If unreachable for >15s:

- Show a non-modal banner: "Connection to {name} lost. [ Reconnect ] [ Switch connection ]"
- The webview stays put (showing stale UI) so the user doesn't lose context
- If user clicks Reconnect: retry with exponential backoff

For local servers specifically: also offer "Restart server" which calls `launchctl kickstart -k <service>`.

## Module structure

Open WebUI Desktop's 2236-line `index.ts` is a clear anti-pattern. We split early:

```
packages/app/src/
├── main/
│   ├── main.ts                  # bootstrap, app lifecycle (200 lines max)
│   ├── window-manager.ts        # BrowserWindow + webview creation
│   ├── deep-links.ts            # autonomos:// protocol handling
│   ├── local-server/
│   │   ├── installer.ts         # install LaunchAgent / systemd-user
│   │   ├── state.ts             # read ~/.autonomos/server-state.json
│   │   └── lifecycle.ts         # start/stop/restart via launchctl
│   ├── config/
│   │   ├── store.ts             # atomic JSON config writes
│   │   ├── tokens.ts            # safeStorage encrypt/decrypt
│   │   └── migration.ts         # schemaVersion bumps
│   └── ipc.ts                   # contextBridge API surface
├── renderer/
│   ├── App.tsx                  # root
│   ├── Welcome.tsx              # first-launch picker
│   ├── ConnectionSidebar.tsx    # left rail
│   ├── AddConnectionModal.tsx   # paste URL + token
│   ├── ConnectionWebview.tsx    # <webview> wrapper
│   └── ConnectionLostBanner.tsx
├── preload/
│   ├── main.ts                  # exposeInMainWorld("autonomosShell", ...)
│   └── content.ts               # injected into the dashboard's webview
├── types/
│   ├── connection.ts
│   └── config.ts
└── shared/
    └── constants.ts             # IPC channel names, default ports, etc.
```

No file should exceed ~300 lines. If something grows beyond that, split.

## Server lifecycle decoupling

| Scenario | Server fate |
|---|---|
| User quits the desktop app | All servers (local + remote) untouched. They keep running. |
| User uninstalls the desktop app | All servers untouched. (Run `autonomos uninstall-service` separately to remove the daemon.) |
| Server crashes | Desktop shows banner. Server is restarted by launchd (KeepAlive=true from Phase 1C). |
| Desktop says "Restart local server" | Calls `launchctl kickstart -k`. Server PID changes; launchd handles it. |
| Mac sleeps / loses network | Local server keeps running. Remote connection drops; reconnects on wake. |

This is the opposite of VS Code Remote-SSH (`vscode-server` shuts down with the client by design). VS Code's lifecycle is correct for an editor; ours is correct for an agent platform.

## Deep link contract

Scheme: `autonomos://`

### `autonomos://connect`

Add a connection to the desktop.

| Query param | Required | Description |
|---|---|---|
| `url` | yes | URL-encoded base URL of the server |
| `token` | yes | URL-encoded bearer token |
| `name` | no | Display name; if absent, derived from hostname |
| `replace` | no | `true` to replace an existing connection with the same URL |

Example: `autonomos://connect?url=https%3A%2F%2Fforge.terrylu.cloud%3A7421&token=abc123&name=forge`

### Future paths (NOT in 1B.2, documented for foresight)

- `autonomos://agent/{id}` — deep-link to a specific agent's pane
- `autonomos://broadcast?text=...` — prefill a broadcast message
- `autonomos://session/{id}/log` — open a session log viewer

The handler MUST whitelist known paths and reject everything else. Future paths just no-op until implemented.

### Auto-launch from server output

`install.sh` (Phase 1C script) gets a small addition: after a successful install, print the `autonomos://connect?...` URL. Already low-effort because the script knows the token + the local IP at that moment. ~5 line change.

## What gets thrown away from 1B.1 (PR #172)

The currently-merged-but-unmerged PR contains the wrong architecture. Specifically:

- `packages/app/src/server-supervisor.ts` — entire file. The desktop never spawns a server in production.
- `packages/app/src/main.ts` — rewrite. Most of its logic was server-spawn + cookie setting; both go away.
- `packages/app/scripts/electron-before-build.sh` — keep the dashboard-build part, simplify (we still need to copy the server bundle into Resources/server/ for the local-install flow, but not for production runtime).

The PR's `electron-builder.yml` config and entitlements file are mostly fine, modulo a few cleanups.

**PR #172 fate**: close unmerged. Document the reason in the PR comment (linking to this design doc and ADR-028). The branch `terry/phase-1b1-electron-shell` can be deleted after close — no salvageable history; we restart from a clean slate.

## What gets salvaged from 1B.1

| Salvageable bit | Why |
|---|---|
| `electron-builder.yml` config | Signing infra, entitlements, bundle ID — all still valid |
| `build-resources/entitlements.mac.plist` | JIT + network entitlements still needed |
| The general directory layout (`packages/app/`) | Matches the new module structure |
| The smoke test scaffolding (`scripts/test-app-smoke.sh`) | Rewrite to test thin-client flows but keep the harness |

The `AUTONOMOS_READY port=N` stdout contract (Phase 1A.1) stays — useful in dev mode (`bun run dev:app` for when there's no installed server) and as a sanity check in the install flow. We don't remove that part of the server.

## Patterns stolen from Open WebUI Desktop

| Pattern | Source file | Adapted use |
|---|---|---|
| Virtual local connection (not stored in array) | `src/main/utils/index.ts:844` (`buildLocalConnection`) | Same approach for our `Connection` array |
| Atomic JSON config write with Promise lock | `src/main/utils/index.ts:887-927` | Verbatim port to TypeScript |
| `MessageChannelMain` PTY data bridge | `src/main/index.ts:989` | Use for streaming session terminal output (high-volume, deserves better than IPC serialization) |
| Per-connection `<webview partition>` for cookie isolation | `Connections/Content.svelte:271` | Verbatim — `partition="persist:connection-${id}"` |
| Inline schema migration at startup | `src/main/index.ts:2177` | Same pragmatic approach for AppConfig version bumps |
| `ServiceLock` for subprocess guards | `src/main/utils/service-lock.ts` | Use for local-server install/start flows |
| Tree-kill with retries on Unix | `src/main/utils/index.ts:694-739` | Use for any subprocess we spawn (local install, dev-mode server) |

## Where we go beyond Open WebUI Desktop

| Their gap | Our improvement |
|---|---|
| `@ts-nocheck` on every main file | Proper TypeScript throughout, no `any`, no escape hatches |
| 2236-line god file | Modular per the file structure above; nothing >300 lines |
| Token sniffed from webview into mutable global | Bearer token field in Connection, encrypted via `safeStorage` |
| No deep links at all | `autonomos://connect?...` first-class, with future-path foresight |
| No crash recovery / notification | "Connection lost" banner, reconnect button, exponential backoff |
| 60-minute readiness poll on startup | 30s timeout with clear failure UI |
| Python downloaded on first launch (~80MB) | Server binary already bundled (Phase 1A.1); zero extra downloads |
| `Setup/*` dead code shipped | Single welcome flow, no dead routes |

## Auth model

### Local connection
- Token generated by `autonomos install-service` and persisted at `~/.autonomos/token` (Phase 1C already does this)
- Desktop reads it once at "Set up local server" completion, stores via `safeStorage` keyed by connection ID
- For HTTP requests: `Authorization: Bearer ${token}` header
- For the webview: token cookie set via `session.defaultSession.cookies.set()` before `loadURL`

### Remote connection
- User pastes the token (which the remote server's `install.sh` printed)
- Same flow: encrypt + persist + cookie + bearer header
- Token never appears in URLs, never logged, never sent to anywhere except the connection's `url`

### Multi-connection isolation
- Each webview has `partition="persist:connection-${id}"` so cookies/storage are isolated
- Bearer-token requests from the main process key off active connection only

## Implementation order

### Sub-phase 1B.2.0 — Cleanup & scaffolding (~½ day)
- Close PR #172 with explanatory comment linking this doc + ADR-028
- New branch: `terry/phase-1b2-thin-client` (worktree already created)
- Strip server-supervisor.ts, rewrite main.ts to a minimal stub
- Set up the module structure in `packages/app/src/`
- Get `bun run dev:app` opening an empty BrowserWindow

### Sub-phase 1B.2.1 — Connection types + persistence (~½ day)
- `types/connection.ts`, `types/config.ts`
- `main/config/store.ts` (atomic JSON write with Promise lock)
- `main/config/tokens.ts` (safeStorage encrypt/decrypt + plaintext fallback)
- `main/config/migration.ts` (no-op stub for schema v1)
- Unit tests for the round-trip + concurrent-write serialization

### Sub-phase 1B.2.2 — Welcome screen + Add Connection (~1 day)
- `renderer/Welcome.tsx` with the two-CTA layout
- `renderer/AddConnectionModal.tsx`
- "Connect to existing server" path: validate via `GET /api/host`, persist, switch active
- IPC contract: `addConnection(input)`, `getConnections()`, `setActiveConnection(id)`

### Sub-phase 1B.2.3 — BrowserWindow + webview lifecycle (~½ day)
- `main/window-manager.ts` creates the main window
- `renderer/ConnectionWebview.tsx` wraps `<webview>` with the right partition + auth
- Renderer routes the welcome → main view when a connection becomes active
- "Connection lost" banner with reconnect

### Sub-phase 1B.2.4 — Deep links (~½ day)
- `main/deep-links.ts` handles `autonomos://` URLs
- `app.setAsDefaultProtocolClient("autonomos")` registration
- `open-url` handler (macOS), argv parsing (Linux/Windows), `second-instance` handler
- Pre-fill Add Connection modal from URL params
- Update `install.sh` in Phase 1C scripts to print the deep-link URL on success

### Sub-phase 1B.2.5 — Local server install flow (~1-1.5 days)
- `main/local-server/installer.ts`: runs the bundled install logic via the existing Phase 1C `autonomos` CLI in `Resources/server/`
- Readiness polling via `~/.autonomos/autonomos.pid` watch (file already shipped by `pid-file.ts` — zero server-side changes needed)
- Renderer: "Installing autonomOS Server..." progress state

### Sub-phase 1B.2.6 — Multi-connection sidebar (~½ day)
- `renderer/ConnectionSidebar.tsx` (left rail)
- Active connection highlight + click-to-switch
- ⌘+1 through ⌘+9 shortcuts
- "Add connection" + per-connection menu (rename, remove, restart-server-for-local)

### Sub-phase 1B.2.7 — Polish + smoke test + DMG (~½ day)
- Rewrite `scripts/test-app-smoke.sh` to test thin-client flows
- `bun run build:dmg` produces a working DMG that does the full flow
- Manual QA pass: install local + add remote + switch + quit-doesn't-touch-servers

**Total estimate: 4-6 days** for a polished 1B.2 PR.

## ADR entries needed

- **ADR-028: Desktop app is a thin client, not a server.** Append to `docs/DECISIONS.md` (drafted alongside this doc).

## Test strategy

- **Unit tests:** config round-trip, token encrypt/decrypt, deep-link URL parsing, schema migration
- **Integration tests:** `scripts/test-app-smoke.sh` rewritten to:
  - Launch Electron with no connections → assert welcome screen
  - Inject a connection via IPC → assert sidebar + active webview load
  - Inject `autonomos://connect?...` URL → assert modal opens pre-filled
  - Quit the app while a "local" connection is set → assert the LaunchAgent server keeps running (probe its port post-quit)
- **Manual QA:** before merge, drag the DMG to /Applications and verify the install→connect→quit→reopen-reconnects flow on Terry's machine

## Open questions for Terry (before A starts)

None that block A. Two ambient questions that can be answered later or punted:

1. **Tray / menubar mode** — should the desktop offer a "keep running in the background" mode where closing the window minimizes to a tray icon? My lean: not in 1B.2, but reserve the architecture for it (don't make it impossible). Open WebUI Desktop has this; we'd add later.
2. **In-app server log viewer** — for the "local server" connection, do we expose a "View server logs" tab that tails the launchd log file? Useful for debugging, but adds surface. My lean: not in 1B.2; users can `tail -f ~/Library/Logs/autonomos.log` themselves until we hear pain.

## References

- [Open WebUI Desktop](https://github.com/open-webui/desktop) — closest precedent
- [MongoDB Compass](https://github.com/mongodb-js/compass) — canonical thin-client model
- [Lens Kubernetes IDE](https://k8slens.dev/) — sidebar/workspace UX
- [n8n Desktop sunset announcement](https://community.n8n.io/t/sunsetting-self-hosted-team-plan-desktop-version/25830) — cautionary tale
- [Phase 1C ADR-???] — daemon supervision via LaunchAgent (already shipped)
- [Phase 1A.1 ADR-???] — bundleable server (already shipped)
- `/tmp/open-webui-desktop/` — local clone for reference during implementation
