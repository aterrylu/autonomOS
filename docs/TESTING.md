# Testing Strategy

> **North star:** validate the artifact a user actually downloads, on the architecture they
> actually run, through the UI they actually see — and assert on real subsystem **health over
> time**, never a synchronous proxy signal.

## Why this exists

Every catastrophic bug in the desktop/release era passed `make check` and broke only in the
*shipped* product. The cause is always a **delta between the test environment and production**:
unit tests run *source* under the *dev machine's* Node, on the *build arch*, with env vars
*pre-set by the test*, against a *fresh in-process* server. The shipped product is a
*bun-bundled + lipo'd + signed* binary under a *pinned bundled Node*, on a *clean machine of
either arch*, with *no env*, reached through an *Electron webview*.

### The failure-class taxonomy (what we must catch)

| # | Class | Real example | Layer that catches it |
|---|-------|--------------|------------------------|
| 1 | Bundler breaks native-module loading | impit napi-rs throw-stubs; node-pty `spawn-helper` unbundled | Bundle smoke (L5) |
| 2 | Build-machine paths/versions baked in | bundled-Node ABI vs `pty.node`; `__dirname` → build node_modules | Clean-machine bundle boot (L5) |
| 3 | Cross-architecture (arm64 build → x64 run) | impit + spawn-helper dead on Intel | Native Intel exec (L6b) |
| 4 | Signing / notarization / Gatekeeper | signed-but-not-notarized still warns | `spctl`/`stapler` on real HW (L7) |
| 5 | Integration seam (app↔webview↔server) | #178 port/token wiring; webview token prompt | Real-spawn + CDP (L3/L6) |
| 6 | **False-pass: green over a dead subsystem** ⚠️ | zombie PTY reports `status:running` | **Liveness-over-time + negative controls** |
| 7 | Lifecycle / resource leaks | leaked ephemeral dirs across restarts | Crash-recovery harness (L1) |
| 8 | Release-asset / CI plumbing | path-doubling; dead `dmg.blockmap` | Dry-run release pipeline |

**Class 6 is the most dangerous** — a green test that *certifies* a broken build. It shipped the
dead-agent-spawn bug in v0.0.1 **and** v0.0.2.

## The layer model

| Layer | What it proves | Tooling | Runs |
|-------|----------------|---------|------|
| **L0 Static** | types + lint | `biome`, `tsc --build` | every PR |
| **L1 Unit** | pure logic per package | `node:test` (server/app), `vitest` (dashboard) | every PR |
| **L2 Component** | React render/behavior | `vitest` + `jsdom` + testing-library | every PR ✅ |
| **L3 Integration — API/PTY** | real server + real agent spawn; #178 wiring; hook telemetry; **liveness** | **real `claude` + mock `/v1/messages`** + isolated server | every PR |
| **L4 Integration — UI** | dashboard works end-to-end in a browser | `Playwright` vs `vite` (API mocked) | every PR ✅ |
| **L5 Artifact smoke** | the **bundled** server boots, native modules load, auth + spawn + liveness | `smoke-test-bundle.sh` under bundled Node | every PR* |
| **L6 Artifact — DMG/CDP** | the packaged `.app` launches; Welcome/auth/first-run UX; CSS-perf invariants | build **unsigned** DMG + `validate-dmg` CDP (**gate**) | every PR* |
| **L6b Native Intel** | the x64 slice actually executes | mount DMG on real `macos-intel`, run L5 | release + nightly |
| **L7 Release gates** | signed + notarized + stapled; Gatekeeper accepts | `codesign`/`spctl`/`stapler` | **release only** |

\* path-filtered: docs-only PRs skip L5–L6.

### What runs when

- **Every PR:** L0–L6 (full unsigned DMG + integration, no signing). Path-filtered so trivial/docs
  PRs skip the heavy artifact gates.
- **Release (`v*` tag / `dry_run=false` dispatch):** all of the above **+ L6b (Intel) + L7 (signing)**.
- **Nightly (main):** L6b + a real-`claude` canary (see below).

Rationale: signing/notarization is **release-only by design** — `release.yml` runs only on tags +
`workflow_dispatch`, never on PRs. Notarizing every build is an anti-pattern (Apple rate-limits,
and the notary can stall for an hour). So notary latency never touches the dev/PR loop.

## Real-agent testing without API cost

autonomOS's assertions — agent spawns under PTY, streams output, hook events POST to the server,
exits cleanly — **don't care what the LLM says**, only the lifecycle + telemetry. The chosen
approach: run the **real `claude` binary** and fake only its `/v1/messages` responses.

- **Chosen — real `claude` + mock `/v1/messages`:** a tiny `node:http` SSE server
  (`packages/server/src/__tests__/helpers/mock-anthropic.ts`) behind `ANTHROPIC_BASE_URL` — which
  the claude-code provider **already injects** from dashboard settings (`buildEnv()` reads
  `getSettings()` → `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`). The integration test
  (`embedded-mode-integration.test.ts`) boots the real server, writes a `settings.json` into the
  isolated `CONFIG_DIR` pointing the spawned agent at the mock, then `POST /api/agents` spawns a
  **real `claude` PTY through the real provider/hook-relay path**. We own the turn loop + stop
  condition in the mock, so the run is deterministic and **zero API cost**.
  - The mock returns SSE: `message_start → content_block_start → content_block_delta → content_block_stop
    → message_delta(end_turn) → message_stop`; `count_tokens → {input_tokens:N}`; everything else → `{}`.
    Matched on `url.includes("/v1/messages") && !includes("count_tokens")` (claude calls
    `POST /v1/messages?beta=true`). A `tool_use` mode emits a `tool_use` block (name + `input_json_delta`)
    on the first turn so `PreToolUse`/`PostToolUse` can be exercised, then end_turn on later turns.
  - autonomOS spawns **interactive** under a PTY (not `-p`), so the `--` prompt is **queued** until a
    submit keystroke. The test drives the prompt through the **real terminal WebSocket**
    (`/ws/terminal/:id` — the same path the dashboard uses) to complete a turn; auto-trust dismisses
    the trust prompt. Asserts the real lifecycle: `SessionStart → UserPromptSubmit → Stop`, then kill
    → record leaves `running` → `SessionEnd → stopped`. Hooks asserted **before** the kill.
  - **Negative control:** pointing the mock URL at a dead port leaves the agent stuck at
    `UserPromptSubmit`/`working` — the Stop assertion fails. Proven the gate can fail (not a
    class-6 false-pass).
  - CI installs the CLI with `npm i -g @anthropic-ai/claude-code@<pinned>` before `make check`
    (installing needs **no auth** — the test never calls the real API). When `claude` is genuinely
    absent locally the suite skips with a clear message.
- **Rejected — [`paultyng/testagent`](https://github.com/paultyng/testagent):** a fake `claude` CLI.
  Rejected on **argv divergence** — it rejects our `--brief`/`--channels` flags as unknown and wants a
  **file-path** `--settings` (we pass inline JSON). Adopting it would force argv mutation in the
  provider purely for tests, diverging the tested path from production. The real-binary approach
  exercises the exact argv we ship.
- **Avoid:** real-model-in-CI (cost, rate-limit flakes, nondeterminism — at most a nightly canary)
  and VCR record/replay of agentic runs (tool loops are nondeterministic; cassettes go brittle).

## Conventions (non-negotiable)

1. **Liveness over time, never a synchronous proxy.** A spawn returning `status:running` is *not*
   proof of life — node-pty's `posix_spawn` returns before a broken helper child dies. Re-assert
   the subsystem's health after a delay (the smoke test re-checks the agent 2s post-spawn).
2. **Ship a negative control.** Every gate must be proven able to *fail* — reproduce the exact
   failure (`{"error":"posix_spawnp failed."}`, the impit crash) without the fix.
3. **Assert behavior, not implementation.** Avoid pinning exact error-message substrings or schema
   shape (`required === undefined`) that break on harmless refactors.
4. **No fake-import tests.** A test must import the real module under test, not a reimplementation
   of its logic (the `channel-schedules` anti-pattern).
5. **Build-time anchor assertions** for fragile upstream coupling (e.g. node-pty's loader shape) —
   fail the build loudly when a dependency changes, instead of shipping a silent regression.
6. **Real-process integration tests are CI-only.** Any suite that spawns a real `claude` PTY or boots
   a real server (L3) is gated behind `AUTONOMOS_INTEGRATION=1`, which **only CI sets** — never a dev
   machine. The dev box is often *also* a live autonomos deployment; running real spawns there (and
   especially any broad `pkill -f claude` cleanup) can kill the operator's live agents. **Never
   broad-kill** — a test kills only its own scoped PIDs / agent ids. Local `make check` skips these
   suites entirely; the unit layers still cover the logic.

## Definition of "safe to release"

Green **L0–L6** on the PR, **plus L6b (Intel) + L7 (signed/notarized/stapled)** on the tag. The
dry-run dispatch (`dry_run=true`) exercises everything except publish, proving the whole pipeline
without cutting a release.

## Rollout phases

- **Phase 1 — Foundation (this doc):** wire the dashboard's 171 `vitest` tests into CI (they were
  orphaned — and had already silently rotted to 2 real failures), fix those regressions, establish
  this strategy. Branch: `terry/test-framework-phase1`.
- **Phase 2 — Real-agent integration (L3):** real `claude` + mock `/v1/messages`; expand
  `embedded-mode-integration.test.ts` with a full real-agent spawn+lifecycle+negative-control test;
  wire the pinned CLI into CI. (`testagent` evaluated and rejected — argv divergence; see above.)
  Branch: `terry/test-framework-phase2`. Remaining for a follow-up: extract the auth middleware so
  the cookie/bootstrap path is unit-testable; fix the `channel-schedules` fake-import.
- **Phase 3 — UI (L2 + L4):** `jsdom` + testing-library component tests; `Playwright` e2e flows
  (create→stream→kill, split-pane, tab switch, settings, reconnect).
  - **Phase 3a — Component tests (L2) ✅ landed.** Stood up the `jsdom` + testing-library layer
    in `packages/dashboard`, wired into the existing `make check` vitest run. jsdom is **opt-in
    per file** via a `// @vitest-environment jsdom` docblock (global default stays `node`, so the
    other ~171 unit tests are untouched); each `*.dom.test.tsx` imports `src/test/setup-dom.ts`,
    which registers `@testing-library/jest-dom` matchers, auto-`cleanup`s between tests, installs
    an in-memory `localStorage` shim (the zustand `persist` store throws on jsdom's Storage
    otherwise), and stubs `canvas.getContext` (xterm's webgl addon probes it at import). Seeded 32
    tests across 6 components: `Codicon`, `agent-status-icon` (+ `agentStatusLabel`),
    `NotificationBell`, `Header`, `CreateAgentPanel` (first-run UX: name-required validation,
    Dispatcher auto-default + "Recommended" badge, `createSession` arg wiring), and
    `HierarchyPanel` (loading/error/empty/populated states). Store-backed components are driven via
    the real store using `useStore.setState(...)`; on-mount `fetch`es are stubbed with
    `vi.stubGlobal`. Remaining for Phase 3b: Playwright e2e (L4) and the heavier store/WebSocket
    components (`SessionPane`, `Sidebar`, `SchedulesPanel`) too entangled for clean isolation.
  - **Phase 3b — Playwright UI e2e (L4) ✅ landed.** Stood up `@playwright/test` (chromium-only) in
    `packages/dashboard`, driving the **real dashboard via the `vite` dev server** with the **entire
    backend mocked in-browser** — `page.route("**/api/**", ...)` returns canned JSON for every
    endpoint the app calls on load (`/api/agents`, `/api/agents/tree`, `/api/settings`,
    `/api/providers`, `/api/templates`, `/api/host`, `/api/hooks`, `/api/projects`, `/api/schedules`,
    `/api/scheduler/status`, `/api/channels/status`) plus the mutations (`POST /api/agents`,
    `PUT /api/settings`) which **capture request bodies** for assertion. The terminal/gateway
    WebSocket is stubbed via an `addInitScript` `FakeWebSocket` that reports CLOSED — so non-terminal
    flows proceed with **zero backend, zero `claude`, zero PTY, zero agents spawned**. Playwright's
    `webServer` boots/tears down `vite` itself (`node_modules/.bin/vite --port 5180 --strictPort`);
    the proxy targets in `vite.config.ts` are never reached because every route is intercepted.
    Layout/active-pane assertions read a **dev-only store bridge** (`window.__autonomosStore`, guarded
    by `import.meta.env.DEV` in `main.tsx` so it's stripped from prod builds) rather than brittle pane
    DOM. **8 specs across 5 flows** in `packages/dashboard/e2e/*.spec.ts` (kept out of `src/` so vitest
    + `tsc --build` ignore them): sidebar lists mocked agents + empty-state first-run auto-open of
    Create Agent; create-agent flow (Dispatcher is the "Recommended" auto-default, submit asserts the
    `POST /api/agents` body, name-required validation blocks submit); `Ctrl+D` split-pane grows the
    layout tree + tab switching (Org Chart → Templates → Org Chart) flips the active pane; settings
    panel opens and the Auto-Trust toggle persists via `PUT /api/settings`; org-chart renders the
    mocked hierarchy tree. CI runs them on every PR via a dedicated `e2e.yml`
    (`bunx playwright install --with-deps chromium` → `bunx playwright test`, `CI=true`,
    `AUTONOMOS_INTEGRATION` deliberately **unset** — no backend needed). **Deferred:** live terminal
    streaming over the real WebSocket (xterm I/O, reconnect-on-disconnect) — needs a WS server mock,
    not just a stub; tracked as future L4 work.
- **Phase 4 — Artifact gates on PR (L5/L6):** bundle smoke + unsigned DMG + CDP gate on every PR,
  path-filtered. Intel (L6b) stays release + nightly; signing (L7) stays release-only.
- **Phase 5a — Electron main-process unit tests (L1) ✅ landed.** The desktop main process had 1 test
  file vs the server's 19 — directly the operator's "the hosted server works great but the desktop app
  is always problematic" pain. Added 43 `node:test` cases across 5 new files (see App inventory below)
  covering `server-supervisor` (Built-in/Always-on decision), `tokens` (safeStorage + 0o600),
  `migrate`, `migration`, and an extracted `drag-controller`. Introduced an `electron-deps.ts` DI seam
  (`_setElectronForTesting`) plus per-module `_setDependenciesForTesting` overrides so `electron`,
  `child_process`, and the HTTP/pid probes are all stubbed — **zero real processes, isolated temp dirs
  for all pid-file/token reads** (the dev box is also a live deployment). Runs in `make check` via the
  existing `tsx --test packages/app/src/main/__tests__/*.test.ts` glob. **Deferred to 5b:** `ipc.ts`,
  `window-manager` BrowserWindow lifecycle, `menu.ts`, `config/store.ts`.

## Current test inventory (as of Phase 1)

- **Server** (`packages/server`, ~334 `node:test` cases): strong on scheduler, `deriveStatus`, the
  #178 `serverState`/token wiring, pid-file, statusline. **Gaps:** boot self-checks, the auth
  cookie/middleware bootstrap, PTY spawn (`agents/runtime.ts`), provider binary detection.
- **Dashboard** (`packages/dashboard`, 203 `vitest` cases): excellent `layoutTree` (77) + `store`
  (28) coverage. **Now wired into CI** (was orphaned). **Component/DOM layer (L2) landed in
  Phase 3a** — 32 jsdom + testing-library cases across 6 components (`*.dom.test.tsx`).
  **UI e2e layer (L4) landed in Phase 3b** — 8 Playwright specs (`e2e/*.spec.ts`) driving the real
  vite dashboard with the API + WebSocket mocked; run on every PR via `e2e.yml` (chromium only).
- **App** (`packages/app`, 48 `node:test` cases — **Phase 5a landed**): the Electron **main process**
  — the operator's "the desktop app is always problematic" pain — now has real unit coverage for its
  highest-risk decision logic. Files in `packages/app/src/main/__tests__/` (run by the same
  `tsx --test` glob as the server, so they're in `make check` automatically):
  - **`server-supervisor.test.ts`** (9) — `acquireOrConnect`'s Built-in-vs-Always-on decision: a live
    pid-file owner ⇒ connect Always-on and **never spawn** (the dangerous duplicate-server case); a
    dead pid or dead port ⇒ fall through to a Built-in spawn; `AUTONOMOS_READY port=N` parsing; the
    `AUTONOMOS_ALREADY_RUNNING` startup-race ⇒ Always-on + child SIGTERM; server-exits-before-ready,
    spawn `error`, and missing-bundle ⇒ clean rejection with **no spawn**; post-resolve stdout ignored.
  - **`tokens.test.ts`** (11) — `safeStorage` encrypt/decrypt round-trip; plaintext fallback when
    encryption is unavailable; the **keychain-flip edge** (per-token `encrypted` flag drives the read,
    not the live probe); decrypt-failure ⇒ `null` (never throws); **`tokens.dat` always mode 0o600**;
    corrupt-file recovery.
  - **`migrate.test.ts`** (6) — Built-in↔Always-on migration shells out to `install-service` /
    `uninstall-service` with the right argv; exit-code → `ok`; stdout/stderr capture; spawn-`error`
    and missing-CLI-bundle handling.
  - **`migration.test.ts`** (10) — `migrateConfig` load-time validation: garbage ⇒ defaults (never
    throws), schema-version normalization, hand-edited bad connections dropped, localhost-`remote`
    dedup. **Pins a found gap:** `isLocalhostRemote` compares against `"::1"` but `URL.hostname`
    returns `"[::1]"` for IPv6, so an IPv6-loopback duplicate is **not** stripped.
  - **`drag-controller.test.ts`** (7) — window-drag state machine (extracted to `drag-controller.ts`,
    electron-free): offset-preserving reposition + **timer-leak guards** (restart, end, destroyed
    window, cleanup-all) — failure-class #7.
  - **`cleanup-leaked-ephemeral.test.ts`** (5) — pre-existing; prefix-exact ephemeral-dir GC.

  **How electron is stubbed (no real Electron / no real process):** main-process modules do
  `import { app } from "electron"`, which **fails to even instantiate** under plain Node/`tsx` (the
  `electron` package's entry resolves to the binary path, not the `app`/`safeStorage` API). So this
  phase added a small **dependency-injection seam** mirroring the server's `_setDependencies(...)`
  pattern: `electron-deps.ts` lazily `require("electron")` in production and exposes
  `_setElectronForTesting({ app, safeStorage })`; `server-supervisor`/`migrate` add
  `_setDependenciesForTesting({ spawn, spawnSync, isPortResponsive, isPidAlive, autonomosHome })` so
  `child_process` and the HTTP/pid probes are faked. **No test creates a real process** (every spawn
  is a `FakeChild` EventEmitter) and the pid-file/token reads are pointed at an **isolated temp dir**,
  never the operator's live `~/.autonomos`. Following the `ephemeral-cleanup.ts` precedent, the drag
  state machine was extracted to its own electron-free module so it needs no stub at all.
  **Still untested (Phase 5b):** `ipc.ts` (large IPC surface, electron-heavy), `window-manager.ts`
  BrowserWindow lifecycle, `menu.ts` (low value / high mock cost), `config/store.ts`.
- **CLI / Core**: no unit tests yet (Phase 2). The `core/dist` test is a gitignored build artifact,
  not real coverage.
- **Deployment gates**: `smoke-test-bundle.sh` (boot+auth+spawn+liveness, release-only today →
  every-PR in Phase 4), `validate-intel` (real x64, hard gate), `validate-dmg` CDP (observe-only
  today → gate in Phase 4), `test-install.sh` (install→start→HTTP→stop on every PR).
