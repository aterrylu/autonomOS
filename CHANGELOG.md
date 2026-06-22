# Changelog

All notable changes to autonomOS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

From the next release onward, the version sections below this line are generated
automatically from [changesets](.changeset/README.md) when the "Version
Packages" PR is merged. The 0.0.1 and 0.0.2 sections are hand-written history
that predates the changesets pipeline.

<!-- changeset-insert-anchor -->

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
