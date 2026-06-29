# Testing Strategy

> **North star:** validate the artifact a user actually downloads, on the architecture they
> actually run, through the UI they actually see — and assert on real subsystem **health over
> time**, never a synchronous proxy signal.

## Why this exists

Every catastrophic release bug passed `make check` and broke only in the *shipped* product. The
cause is always a **delta between the test environment and production**: unit tests run *source*
under the *dev machine's* Node, on the *build arch*, with env vars *pre-set by the test*, against a
*fresh in-process* server. The shipped product is a *bun-bundled per-platform server tarball* under
a *pinned bundled Node*, installed via `install.sh` on a *clean machine* (matching the target
platform/arch), with *no env* — the dashboard is served by that server and reached through a
*browser / PWA*.

### The failure-class taxonomy (what we must catch)

| # | Class | Real example | Layer that catches it |
|---|-------|--------------|------------------------|
| 1 | Bundler breaks native-module loading | impit napi-rs throw-stubs; node-pty `spawn-helper` unbundled | Bundle smoke (L5) |
| 2 | Build-machine paths/versions baked in | bundled-Node ABI vs `pty.node`; `__dirname` → build node_modules | Clean-machine bundle boot (L5) |
| 3 | Per-platform native build broken on one target | impit + spawn-helper dead on a given os/arch tarball | Per-arch tarball install/boot (L5) |
| 5 | Integration seam (server↔dashboard) | #178 port/token wiring; auth/bootstrap handshake | Real-spawn + Playwright (L3/L4) |
| 6 | **False-pass: green over a dead subsystem** ⚠️ | zombie PTY reports `status:running` | **Liveness-over-time + negative controls** |
| 7 | Lifecycle / resource leaks | leaked ephemeral dirs across restarts | Crash-recovery harness (L1) |
| 8 | Release-asset / CI plumbing | path-doubling; wrong tarball layout | Dry-run release pipeline |

> Classes 4 (signing/notarization/Gatekeeper) and the Electron-renderer half of class 5
> (app↔webview) were retired with the Electron desktop app (ADR-051) — there is no signed `.app`
> or webview to certify anymore.

**Class 6 is the most dangerous** — a green test that *certifies* a broken build. It shipped the
dead-agent-spawn bug in v0.0.1 **and** v0.0.2.

## The layer model

| Layer | What it proves | Tooling | Runs |
|-------|----------------|---------|------|
| **L0 Static** | types + lint | `biome`, `tsc --build` | every PR |
| **L1 Unit** | pure logic per package | `node:test` (server), `vitest` (dashboard) | every PR |
| **L2 Component** | React render/behavior | `vitest` + `jsdom` + testing-library | every PR ✅ |
| **L3 Integration — API/PTY** | real server + real agent spawn; #178 wiring; hook telemetry; **liveness** | **real `claude` + mock `/v1/messages`** + isolated server | every PR |
| **L4 Integration — UI** | dashboard works end-to-end in a browser | `Playwright` vs `vite` (API mocked) | every PR ✅ |
| **L5 Artifact install/boot** | a per-platform server tarball installs, boots, serves HTTP, stops cleanly | `test-install.yml` (`install.sh` → start → HTTP → stop) | every PR* |

\* path-filtered: docs-only PRs skip L5.

> A dedicated *bundled-server* smoke (native-module load + spawn + liveness on the tarball, in the
> spirit of the old `smoke-test-bundle.sh`) is **future work** — today the tarball gate is
> install/boot/HTTP via `test-install.yml`; deeper subsystem liveness is asserted at L3 against an
> isolated source server.

### What runs when

- **Every PR:** L0–L5 (static + unit + component + integration + per-platform tarball install).
  Path-filtered so trivial/docs PRs skip the heavier artifact gates.
- **Release (`v*` tag / `dry_run=false` dispatch):** the same gates plus the full server-tarball
  build pipeline for all four targets (darwin/linux × arm64/x64).
- **Nightly (main):** a real-`claude` canary (see below).

## Real-agent testing without API cost

autonomOS's assertions — agent spawns under PTY, streams output, hook events POST to the server,
exits cleanly — **don't care what the LLM says**, only the lifecycle + telemetry. The chosen
approach: run the **real `claude` binary** and fake only its `/v1/messages` responses.

- **Chosen — real `claude` + mock `/v1/messages`:** a tiny `node:http` SSE server
  (`packages/server/src/__tests__/helpers/mock-anthropic.ts`) behind `ANTHROPIC_BASE_URL` — which
  the claude-code provider **already injects** from dashboard settings (`buildEnv()` reads
  `getSettings()` → `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`). The shared harness
  (`packages/server/src/__tests__/helpers/test-server.ts`, `bootServer()`) boots the real server
  with `--port=0` and reads the port off the server's standard `listening on http://...:<port>`
  startup log line; the surviving L3 suites (`agent-spawn-prompt.test.ts`,
  `usage-queue-integration.test.ts`, `usage-queue-sim-integration.test.ts`) write a `settings.json`
  into the isolated `CONFIG_DIR` pointing the spawned agent at the mock, then `POST /api/agents`
  spawns a **real `claude` PTY through the real provider/hook-relay path**. We own the turn loop +
  stop condition in the mock, so the run is deterministic and **zero API cost**.
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
   the subsystem's health after a delay (the L3 integration suite re-checks the agent post-spawn,
   asserting hook telemetry advanced before the kill).
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

Green **L0–L5** on the PR (static + unit + component + integration + the per-platform tarball
install gate), **plus** a clean four-target server-tarball build on the tag. There are no
signing / notarization / Intel-DMG gates anymore (ADR-051). The dry-run dispatch (`dry_run=true`)
exercises the whole build pipeline except publish, proving it without cutting a release.

## Rollout phases

- **Phase 1 — Foundation (this doc):** wire the dashboard's 171 `vitest` tests into CI (they were
  orphaned — and had already silently rotted to 2 real failures), fix those regressions, establish
  this strategy. Branch: `terry/test-framework-phase1`.
- **Phase 2 — Real-agent integration (L3):** real `claude` + mock `/v1/messages`; a full real-agent
  spawn+lifecycle+negative-control test via the shared `helpers/test-server.ts` harness (suites:
  `agent-spawn-prompt.test.ts`, `usage-queue-integration.test.ts`, `usage-queue-sim-integration.test.ts`);
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
- **Phase 4 — Artifact gates on PR (L5) ✅ landed.** The per-platform **server-tarball** build runs on
  every artifact-touching PR, not just release — so native-module / bundling / clean-machine
  regressions (the #178-class bugs) are caught at PR time. The build pipeline lives in a reusable
  `workflow_call` workflow (`reusable-server-build.yml`) that produces the four server tarballs
  (darwin/linux × arm64/x64); `test-install.yml` then exercises the install/boot path
  (`install.sh` → start → HTTP → stop) on a clean runner. Path-filtered to the server/cli/core
  packages + the build workflows — docs-only / dashboard-only PRs skip it.
- **Electron tests removed (ADR-051).** The former Phase 5a (Electron main-process `node:test` suite,
  `packages/app`) and Phase 6 (idle-renderer CPU peg-detector via `validate-dmg`) were deleted with
  the desktop app — they certified renderer/`.app` behavior that no longer exists.

## Current test inventory (as of Phase 1)

- **Server** (`packages/server`, ~334 `node:test` cases): strong on scheduler, `deriveStatus`, the
  #178 `serverState`/token wiring, pid-file, statusline. **Gaps:** boot self-checks, the auth
  cookie/middleware bootstrap, PTY spawn (`agents/runtime.ts`), provider binary detection.
- **Dashboard** (`packages/dashboard`, 203 `vitest` cases): excellent `layoutTree` (77) + `store`
  (28) coverage. **Now wired into CI** (was orphaned). **Component/DOM layer (L2) landed in
  Phase 3a** — 32 jsdom + testing-library cases across 6 components (`*.dom.test.tsx`).
  **UI e2e layer (L4) landed in Phase 3b** — 8 Playwright specs (`e2e/*.spec.ts`) driving the real
  vite dashboard with the API + WebSocket mocked; run on every PR via `e2e.yml` (chromium only).
- **CLI / Core**: no unit tests yet (Phase 2). The `core/dist` test is a gitignored build artifact,
  not real coverage.
- **Deployment gates**: `reusable-server-build.yml` builds the four per-platform server tarballs
  (darwin/linux × arm64/x64) and `test-install.yml` exercises the install/boot path on a clean runner
  (`install.sh` → start → HTTP → stop), on every PR. A deeper bundled-server smoke
  (native-module load + spawn + liveness on the tarball, à la the retired `smoke-test-bundle.sh`)
  remains **future work** — until then, subsystem liveness is asserted at L3 against an isolated
  source server.
