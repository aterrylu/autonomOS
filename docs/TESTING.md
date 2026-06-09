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
| **L4 Integration — UI** | dashboard works end-to-end in a browser | `Playwright` vs `make dev` | every PR |
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
- **Phase 4 — Artifact gates on PR (L5/L6):** bundle smoke + unsigned DMG + CDP gate on every PR,
  path-filtered. Intel (L6b) stays release + nightly; signing (L7) stays release-only.

## Current test inventory (as of Phase 1)

- **Server** (`packages/server`, ~334 `node:test` cases): strong on scheduler, `deriveStatus`, the
  #178 `serverState`/token wiring, pid-file, statusline. **Gaps:** boot self-checks, the auth
  cookie/middleware bootstrap, PTY spawn (`agents/runtime.ts`), provider binary detection.
- **Dashboard** (`packages/dashboard`, 203 `vitest` cases): excellent `layoutTree` (77) + `store`
  (28) coverage. **Now wired into CI** (was orphaned). **Component/DOM layer (L2) landed in
  Phase 3a** — 32 jsdom + testing-library cases across 6 components (`*.dom.test.tsx`).
- **App** (`packages/app`): only `ephemeral-cleanup` tested; `server-supervisor`, `ipc`, `tokens`
  untested (high-risk — Phase 2/3).
- **CLI / Core**: no unit tests yet (Phase 2). The `core/dist` test is a gitignored build artifact,
  not real coverage.
- **Deployment gates**: `smoke-test-bundle.sh` (boot+auth+spawn+liveness, release-only today →
  every-PR in Phase 4), `validate-intel` (real x64, hard gate), `validate-dmg` CDP (observe-only
  today → gate in Phase 4), `test-install.sh` (install→start→HTTP→stop on every PR).
