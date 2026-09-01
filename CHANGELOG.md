# Changelog

All notable changes to autonomOS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

From the next release onward, the version sections below this line are generated
automatically from [changesets](.changeset/README.md) when the "Version
Packages" PR is merged. The 0.0.1 and 0.0.2 sections are hand-written history
that predates the changesets pipeline.

<!-- changeset-insert-anchor -->

## [0.7.0] — 2026-09-01

### Minor Changes

- [#353](https://github.com/aterrylu/autonomOS/pull/353) `1b73ba7` — feat(dashboard): right-click context menu on agent rows (ADR-093)
- [#355](https://github.com/aterrylu/autonomOS/pull/355) `847a11d` — feat(handoff): hand-off queue — human-mediated inbound for inbound-less agents (server)
- [#356](https://github.com/aterrylu/autonomOS/pull/356) `c77fea2` — feat(handoff): hand-off queue dashboard — badge + minimal delivery overlay
- [#357](https://github.com/aterrylu/autonomOS/pull/357) `d1e66a8` — feat(dashboard): sidebar drag-reorder revamp — whole-row native + slide-apart

### Patch Changes

- [#346](https://github.com/aterrylu/autonomOS/pull/346) `fb34e6c` — feat(dashboard): status-label muted-accent colors + working shimmer (ADR-090)
- [#348](https://github.com/aterrylu/autonomOS/pull/348) `c54d778` — fix(codex): suppress the in-pane self-update popup that kills spawned sessions (ADR-091)
- [#349](https://github.com/aterrylu/autonomOS/pull/349) `1dd3d13` — feat(gateway): schedule://<name> sender scheme for scheduled prompts (ADR-092)
- [#350](https://github.com/aterrylu/autonomOS/pull/350) `5ce42c7` — fix(server): config-dir test-escape guard — tests can never touch the real ~/.autonomos
- [#351](https://github.com/aterrylu/autonomOS/pull/351) `6276dba` — feat(agents): lastActivityAt — session recency that survives upgrades
- [#352](https://github.com/aterrylu/autonomOS/pull/352) `15a4521` — fix(codex): advance lastActivityAt from the status feed (T2, #351)
- [#354](https://github.com/aterrylu/autonomOS/pull/354) `72d648a` — fix(terminal): full-viewport refresh after WebGL recreate (blackout hardening)


## [0.6.1] — 2026-08-26

### Patch Changes

- [#344](https://github.com/aterrylu/autonomOS/pull/344) `a1f34a5` — fix(install): migrate AUTONOMOS_TOKEN across source migration — upgrades never break existing auth (ADR-089)


## [0.6.0] — 2026-08-25

### Minor Changes

- [#319](https://github.com/aterrylu/autonomOS/pull/319) `00953d9` — feat(shortcuts): ⌘K agent quick-switcher (ADR-073) — terminal-clear moves to ⌘⇧K
- [#320](https://github.com/aterrylu/autonomOS/pull/320) `10e7f47` — feat(cli): autonomos upgrade/rollback — recorded install marker, health gate, auto-rollback (ADR-071, PR 1/3)
- [#321](https://github.com/aterrylu/autonomOS/pull/321) `a0bfdd5` — feat(cli): source-mode upgrades — managed clone pinned to release tags (ADR-071, PR 2/3)
- [#323](https://github.com/aterrylu/autonomOS/pull/323) `94ee89c` — feat(dashboard): passive update badge — server-side cached release check (ADR-072, PR 3/3)
- [#333](https://github.com/aterrylu/autonomOS/pull/333) `058f751` — feat(cli): idempotent supervisor-unit sync on upgrade (ADR-080) + test-only service label (ADR-081)
- [#340](https://github.com/aterrylu/autonomOS/pull/340) `9a7ccd2` — feat(dashboard): draggable per-terminal usage-queue overlay

### Patch Changes

- [#310](https://github.com/aterrylu/autonomOS/pull/310) `1d9adc7` — ci(release): blocking changeset-check + sync-changelog collapse guard + /release skill footer fix
- [#311](https://github.com/aterrylu/autonomOS/pull/311) `9221e35` — feat(dashboard): move env-preset pill to row bottom-right + gold accent highlight
- [#314](https://github.com/aterrylu/autonomOS/pull/314) `040729d` — fix(notifications): kill the false-positive warning classes from the live-install audit
- [#316](https://github.com/aterrylu/autonomOS/pull/316) `05e4ffa` — perf(terminal): instant agent switch — keep-alive terminal cache + coalesced reconnect-replay (ADR-072)
- [#317](https://github.com/aterrylu/autonomOS/pull/317) `e5485b7` — fix(usage): bar/queue window alignment + auto-detect selects the credential source (ADR-075)
- [#318](https://github.com/aterrylu/autonomOS/pull/318) `0389128` — fix(prompt-delivery): settle-gated receipt windows + retractable give-up (ADR-072)
- [#322](https://github.com/aterrylu/autonomOS/pull/322) `f54f0db` — refactor(shortcuts): Escape protects popover drafts + terminal keymap as data + help Tab trap
- [#330](https://github.com/aterrylu/autonomOS/pull/330) `3d4bed1` — refactor(api): conventions ADR + dead-surface removal (consolidation PR 1)
- [#334](https://github.com/aterrylu/autonomOS/pull/334) `43c6a4e` — feat(dashboard): API client layer + push-over-poll migration (consolidation PR A, ADR-082)
- [#335](https://github.com/aterrylu/autonomOS/pull/335) `d3cd50c` — feat(server): typed errors + one Zod source + store-level secrets guard (consolidation PR B, ADR-083)
- [#336](https://github.com/aterrylu/autonomOS/pull/336) `8922e24` — feat(server): route renames behind one-release compat aliases (consolidation PR C, ADR-084)
- [#337](https://github.com/aterrylu/autonomOS/pull/337) `59a09c4` — fix(codex): stop per-session MCP approval prompt — mode-aware pre-approval + read-only annotations (ADR-085)
- [#339](https://github.com/aterrylu/autonomOS/pull/339) `db7706d` — fix(terminal): atomic repaints (trailing-edge coalescing) + jump-to-latest pill (ADR-086)
- [#341](https://github.com/aterrylu/autonomOS/pull/341) `1bb7bcd` — fix(terminal): remove focus-path fake-resize nudge; anchor parked viewports across scrollback wipes (ADR-087)
- [#342](https://github.com/aterrylu/autonomOS/pull/342) `b0dbbac` — fix(gateway): fail loud on inbound to a no-inbound runtime (Gemini) instead of false-acking
- [#343](https://github.com/aterrylu/autonomOS/pull/343) `a629132` — feat(dashboard): recency timestamp fade on agent rows (ADR-088)


## [0.5.0] — 2026-08-08

### Minor Changes

- [#271](https://github.com/aterrylu/autonomOS/pull/271) `744adc2` — feat(server): retire pm2 from operator path — launchd/systemd-user supervision + rotating logs
- [#272](https://github.com/aterrylu/autonomOS/pull/272) `131fa2b` — feat(cli): first-run install UX — post-install smoke test + connect panel
- [#273](https://github.com/aterrylu/autonomOS/pull/273) `ea57b14` — refactor: cut the Electron desktop app — remote always-on server is canonical (ADR-051)
- [#276](https://github.com/aterrylu/autonomOS/pull/276) `509ed54` — feat(dashboard): Codex usage tracking plugin (live /wham/usage + rollout fallback)
- [#283](https://github.com/aterrylu/autonomOS/pull/283) `4f1e5c6` — fix(server): resume external Claude Code sessions — adopt-into-managed (ADR-056)
- [#284](https://github.com/aterrylu/autonomOS/pull/284) `7bbb876` — feat(security): move /mcp + agent hook relay onto a Unix socket (ADR-055 PR A) — **breaking transport change**
- [#288](https://github.com/aterrylu/autonomOS/pull/288) `4b6c758` — refactor(mcp): deprecate agent capabilities — bypassable + misleading (ADR-058)
- [#289](https://github.com/aterrylu/autonomOS/pull/289) `2777645` — refactor(dashboard): remove the broken markdown file preview (ADR-059)
- [#293](https://github.com/aterrylu/autonomOS/pull/293) `b45043d` — feat(security): gateway onto the control socket + per-agent identity (ADR-055 PR B)
- [#299](https://github.com/aterrylu/autonomOS/pull/299) `28b0adc` — fix(gateway): send() acks DELIVERY, not routing — remove broadcast:// and slack:// (ADR-064)
- [#300](https://github.com/aterrylu/autonomOS/pull/300) `b7222e1` — feat(dashboard): keyboard shortcut registry + mod+digit pane switching (ADR-063)
- [#302](https://github.com/aterrylu/autonomOS/pull/302) `c8262cd` — feat(providers): model-override env presets — agent-configured, human-keyed (ADR-067)
- [#304](https://github.com/aterrylu/autonomOS/pull/304) `b230d72` — fix(shortcuts): free the dead ctrl+d/w/b swallow + registry Escape dismissal (ADR-065)
- [#305](https://github.com/aterrylu/autonomOS/pull/305) `d2e1e2e` — feat(shortcuts): mod+digit switches sidebar agents + hold-mod row badges (ADR-066)
- [#306](https://github.com/aterrylu/autonomOS/pull/306) `e79aa84` — feat(shortcuts): mod+↑/↓ relative agent navigation + neighbor hint chips
- [#308](https://github.com/aterrylu/autonomOS/pull/308) `b64326f` — feat(usage-queue): per-tab + per-runtime auto-Enter (ADR-068)
- [#309](https://github.com/aterrylu/autonomOS/pull/309) `470b045` — docs(changeset): complete the v0.5.0 changelog — retroactive changesets for 5 undocumented PRs

### Patch Changes

- [#269](https://github.com/aterrylu/autonomOS/pull/269) `e6b8290` — feat(dashboard): distinct highlight for co-visible sidebar rows
- [#270](https://github.com/aterrylu/autonomOS/pull/270) `f5c4939` — fix(server): keep Claude Code agents on restart via provider-parity resume fallback
- [#274](https://github.com/aterrylu/autonomOS/pull/274) `788d3df` — fix(security): stop leaking the auth token in a URL (post-install panel)
- [#278](https://github.com/aterrylu/autonomOS/pull/278) `f7a1f60` — fix(server): recover agent status after compaction — order-independent hooks (ADR-053)
- [#281](https://github.com/aterrylu/autonomOS/pull/281) `df6806e` — fix(security): require auth on /mcp — closes an unauthenticated RCE (ADR-054)
- [#282](https://github.com/aterrylu/autonomOS/pull/282) `d973992` — fix(dashboard): eliminate layout/terminal/store stuck-states (audit sweep)
- [#287](https://github.com/aterrylu/autonomOS/pull/287) `84a8bbd` — fix(codex): stop losing inbound messages in silence + kill the prompt-delivery false alarm
- [#294](https://github.com/aterrylu/autonomOS/pull/294) `59aade5` — fix(codex): inject inbound immediately — remove the idle gate (ADR-060)
- [#296](https://github.com/aterrylu/autonomOS/pull/296) `3064753` — fix(permissions): the record follows the process; rename `default` → `ask` (ADR-061)
- [#297](https://github.com/aterrylu/autonomOS/pull/297) `7edfc47` — fix(security): consolidate per-agent token delivery to a 0600 file (ADR-055 follow-up)
- [#298](https://github.com/aterrylu/autonomOS/pull/298) `fa1370c` — refactor(scheduler): remove the isolated target — the last spawn outside PermissionMode (ADR-062)
- [#301](https://github.com/aterrylu/autonomOS/pull/301) `bed3654` — refactor(security): hygiene bundle — dir-modes, config validation, link-scheme filter, dep bumps
- [#307](https://github.com/aterrylu/autonomOS/pull/307) `2319e96` — refactor(mcp): rewrite MCP_INSTRUCTIONS + drift-guard test + peer-discovery note


## [0.4.0] — 2026-06-28

### Minor Changes

- [#249](https://github.com/aterrylu/autonomOS/pull/249) `8a0257a` — feat(dashboard): default hierarchical sidebar view + remove exited-agents list
- [#250](https://github.com/aterrylu/autonomOS/pull/250) `4e1fde3` — feat(dashboard): flat-view agent pinning + drag-reorder
- [#257](https://github.com/aterrylu/autonomOS/pull/257) `08de6c2` — feat(settings): per-provider permission modes (replaces autonomousMode)
- [#261](https://github.com/aterrylu/autonomOS/pull/261) `4806642` — fix(settings): default permission mode is 'default', not 'bypass' (fail-closed)
- [#263](https://github.com/aterrylu/autonomOS/pull/263) `0998a6d` — feat(dashboard): rebuild tabs + split-pane layout on dockview, default on

### Patch Changes

- [#244](https://github.com/aterrylu/autonomOS/pull/244) `49e35f8` — fix(release): consolidated CHANGELOG.md misses changesets without @autonomos/app
- [#248](https://github.com/aterrylu/autonomOS/pull/248) `69b9a2e` — feat(dashboard): brighter active-agent highlight in sidebar
- [#253](https://github.com/aterrylu/autonomOS/pull/253) `37b4372` — perf(server): flag-gated PTY→WebSocket frame coalescing + ablation harness
- [#254](https://github.com/aterrylu/autonomOS/pull/254) `5b57cfe` — fix(server): resume after self_exit fails with 'resumeAgentId not found'
- [#255](https://github.com/aterrylu/autonomOS/pull/255) `1c393c5` — feat(dashboard): vertical pin icon in flat-view sidebar rows
- [#258](https://github.com/aterrylu/autonomOS/pull/258) `42b56a4` — fix(claude-usage): switch accounts when a new Claude session is detected
- [#259](https://github.com/aterrylu/autonomOS/pull/259) `8117dfe` — test(server): quarantine usage-queue-sim-integration flake
- [#260](https://github.com/aterrylu/autonomOS/pull/260) `c786abd` — perf(server): enable terminal frame coalescing by default (leading-edge)
- [#264](https://github.com/aterrylu/autonomOS/pull/264) `c36e0ae` — feat(claude-usage): read-only OAuth usage + manual override; remove cookie scan
- [#265](https://github.com/aterrylu/autonomOS/pull/265) `333534d` — fix(dashboard): clearer permission-mode labels (Ask, Accept edits)
- [#266](https://github.com/aterrylu/autonomOS/pull/266) `a2815cb` — refactor(dashboard): remove the legacy layout engine (dockview-only)


## [0.3.0] — 2026-06-22

### Patch Changes

- [#208](https://github.com/aterrylu/autonomOS/pull/208) [`06389b0`](https://github.com/aterrylu/autonomOS/commit/06389b0c07912c68c0e1ca168e95c08296d2db82) Thanks [@aterrylu](https://github.com/aterrylu)! - Fix Claude Code statusline not applying in the desktop app. Two runtime-loaded scripts (the statusline renderer and the per-agent MCP channel-server) were referenced by path but never copied into the bundled server, so spawned sessions silently lost the statusline and the agent messaging tools. The build now stages both scripts (with a manifest), path resolution is centralized in scriptPaths.ts so source and bundle stay consistent, the server warns at boot if a script is missing, and the bundle smoke test fails on any missing runtime script.


## [0.2.0] — 2026-06-10




## [0.1.0] — 2026-06-08

### Minor Changes

- [#183](https://github.com/aterrylu/autonomOS/pull/183) [`f301061`](https://github.com/aterrylu/autonomOS/commit/f3010614a016bbb4c5ef2b33a433401f0471cbe9) Thanks [@aterrylu](https://github.com/aterrylu)! - Professional release pipeline: universal2 macOS DMG built and validated in CI (lipo'd Node + native modules across arm64/x64), changesets-driven versioning with a single root CHANGELOG, lefthook + commitlint git hooks, and CHANGELOG-derived GitHub Release notes.

### Patch Changes

- [#186](https://github.com/aterrylu/autonomOS/pull/186) [`9c81ca4`](https://github.com/aterrylu/autonomOS/commit/9c81ca4067c76846bf664df5faefaaa8452048c5) Thanks [@aterrylu](https://github.com/aterrylu)! - Release pipeline: add a dry-run dispatch mode to test the universal DMG build without publishing, and SLSA build-provenance attestations on shipped artifacts.

- [#187](https://github.com/aterrylu/autonomOS/pull/187) [`ec1f536`](https://github.com/aterrylu/autonomOS/commit/ec1f5363849dfa04d7f12c30043dd572678cd0de) Thanks [@aterrylu](https://github.com/aterrylu)! - Fixed: the universal2 macOS app now runs on Intel Macs (a native HTTP dependency failed to load) and Built-in mode reliably spawns agents on both Apple Silicon and Intel (the bundled PTY spawn helper wasn't shipped correctly). Earlier 0.0.x desktop builds were affected.


## [0.0.2] — unreleased baseline

The desktop-app era. Built but never cut as a formal signed release — the work
here is the baseline the first changesets-driven release supersedes.

### Added
- **Desktop app — Built-in / Always-on / Remote modes** (ADR-028 + ADR-029).
  The macOS Desktop can run an embedded server, supervise an always-on daemon,
  or connect to a remote server. (#173)
- **"Try it out" ephemeral mode** — spin up a throwaway server in an isolated
  temp dir straight from the Welcome screen; cleared on quit (ADR-030). (#179)
- **End-to-end DMG validation** — `validate-dmg.sh` drives the packaged app via
  CDP to assert the Welcome flow, auto-auth, and first-run UX; the bundle
  smoke-test now covers the auth-cookie path. (#180)

### Changed
- **Statusline** — intelligent duration formatting + clock-glyph spacing. (#174)

### Fixed
- **Built-in server reachability** — spawned Claude Code sessions now phone home
  to the actual bound port + token (routed via `serverState`), fixing silent
  hook/MCP failures when the server runs on an OS-assigned port. (#178)
- **200% CPU peg on the Welcome window** — removed the stacked macOS vibrancy +
  CSS `backdrop-filter` that pegged the GPU compositor. (#176)

### Removed
- **`autonomos://` deep-link handler** — dropped over phishing-surface concerns;
  pairing is paste-URL-and-token in the "Add a server" modal. (#175)

## [0.0.1] — 2026-05-15

First public release. Terminal-style agent dashboard, session spawning, hook
telemetry relay, the URI-based multi-agent gateway, MCP tools, the cron
scheduler, and the Phase 1C server distribution stack (`install.sh`,
launchd/systemd-user supervision, `autonomos` CLI).

[0.0.2]: https://github.com/aterrylu/autonomOS/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/aterrylu/autonomOS/releases/tag/v0.0.1
