# Changelog

All notable changes to autonomOS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

From the next release onward, the version sections below this line are generated
automatically from [changesets](.changeset/README.md) when the "Version
Packages" PR is merged. The 0.0.1 and 0.0.2 sections are hand-written history
that predates the changesets pipeline.

<!-- changeset-insert-anchor -->

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
