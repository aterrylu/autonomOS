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
| **L2 Component** | React render/behavior | `vitest` + `jsdom` + testing-library | every PR |
| **L3 Integration — API/PTY** | real server + real agent spawn; #178 wiring; hook telemetry; **liveness** | `testagent` fake-`claude` + isolated server | every PR |
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
exits cleanly — **don't care what the LLM says**, only the lifecycle + telemetry. So the right
altitude is a fake **CLI**, not a mocked API.

- **Primary — [`paultyng/testagent`](https://github.com/paultyng/testagent):** a deterministic
  fake of the `claude` CLI built to test hook relays + orchestrators under a real PTY. Honors our
  exact spawn flags (`--session-id`, `--settings`, `--mcp-config`, `--resume`…), fires real hook
  payloads (11 of our 13 events), and acts as a **real MCP client**. Vendored as a pinned release
  binary; tests point the provider's `claude` resolution at it via `PATH`.
  - **Spike first:** confirm it tolerates our `--brief` / `--dangerously-load-development-channels`
    flags (wrap or upstream a fix if it hard-errors on unknowns).
  - Gaps: doesn't model `SubagentStart`/`SubagentStop`/`PostToolUseFailure` — cover those at unit level.
- **Secondary — mock `/v1/messages`:** a tiny Hono SSE server behind `ANTHROPIC_BASE_URL` (which our
  provider already injects) drives the **real `claude` binary** for one high-fidelity smoke test —
  catches flag/`--settings` parsing regressions testagent can't model. We own the multi-turn loop +
  stop condition, so keep it to one or two tests.
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

## Definition of "safe to release"

Green **L0–L6** on the PR, **plus L6b (Intel) + L7 (signed/notarized/stapled)** on the tag. The
dry-run dispatch (`dry_run=true`) exercises everything except publish, proving the whole pipeline
without cutting a release.

## Rollout phases

- **Phase 1 — Foundation (this doc):** wire the dashboard's 171 `vitest` tests into CI (they were
  orphaned — and had already silently rotted to 2 real failures), fix those regressions, establish
  this strategy. Branch: `terry/test-framework-phase1`.
- **Phase 2 — Real-agent integration (L3):** vendor `testagent`; un-skip + expand
  `embedded-mode-integration.test.ts`; extract the auth middleware so the cookie/bootstrap path is
  testable; fix the `channel-schedules` fake-import; add the mock-`/v1/messages` smoke.
- **Phase 3 — UI (L2 + L4):** `jsdom` + testing-library component tests; `Playwright` e2e flows
  (create→stream→kill, split-pane, tab switch, settings, reconnect).
- **Phase 4 — Artifact gates on PR (L5/L6):** bundle smoke + unsigned DMG + CDP gate on every PR,
  path-filtered. Intel (L6b) stays release + nightly; signing (L7) stays release-only.

## Current test inventory (as of Phase 1)

- **Server** (`packages/server`, ~334 `node:test` cases): strong on scheduler, `deriveStatus`, the
  #178 `serverState`/token wiring, pid-file, statusline. **Gaps:** boot self-checks, the auth
  cookie/middleware bootstrap, PTY spawn (`agents/runtime.ts`), provider binary detection.
- **Dashboard** (`packages/dashboard`, 171 `vitest` cases): excellent `layoutTree` (77) + `store`
  (28) coverage. **Now wired into CI** (was orphaned). No component/DOM layer yet (Phase 3).
- **App** (`packages/app`): only `ephemeral-cleanup` tested; `server-supervisor`, `ipc`, `tokens`
  untested (high-risk — Phase 2/3).
- **CLI / Core**: no unit tests yet (Phase 2). The `core/dist` test is a gitignored build artifact,
  not real coverage.
- **Deployment gates**: `smoke-test-bundle.sh` (boot+auth+spawn+liveness, release-only today →
  every-PR in Phase 4), `validate-intel` (real x64, hard gate), `validate-dmg` CDP (observe-only
  today → gate in Phase 4), `test-install.sh` (install→start→HTTP→stop on every PR).
