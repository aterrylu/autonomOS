## ADR-031: Professional release pipeline (changesets + universal CI DMG)
**Date:** 2026-06-06
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session — "revamp releases to industry standard, boil the ocean"
**Status:** Drafted by feature worker, pending team-lead review. (Numbering note:
ADR-030's follow-ups informally forward-referenced "ADR-031" for *named profiles*;
that feature is unbuilt and speculative, so this ADR claims ADR-031 for the
release pipeline — the decision actually being made. Named profiles, if ever
built, take a later number.)

**Context:** Releases were manual and fragile. Versions were bumped by hand-editing
five `package.json` files with `sed`, which produced a real drift (code at `0.0.2`,
last tag `v0.0.1` — the 0.0.2 bump shipped in #177 was never tagged or released).
The macOS Desktop DMG — the primary user-facing artifact — was built **locally on a
developer's Mac, never in CI, never validated, and dragged into the release by
hand**. There was no changelog (release notes were GitHub's raw commit dump), no
code signing (Gatekeeper warning on every install), no auto-update, and no written
runbook. The server tarballs were the only professionally-built artifact (CI matrix
+ SHA256SUMS). This repeatedly caused "ship → user finds it broken" cycles.

**Decision:** Adopt the canonical 2026 stack, sequenced as six PRs:

1. **changesets** with a `fixed` group (all packages lockstep to one version),
   `@changesets/changelog-github`, a single root `CHANGELOG.md` (per-package
   changelogs gitignored; `scripts/sync-changelog.ts` promotes each version into
   the root). A `version.yml` workflow maintains the "Version Packages" PR and
   auto-tags `vX.Y.Z` on its merge. **Releasing = merge that PR.**
2. **lefthook + commitlint** — the pre-push hook runs the exact CI gate
   (`biome check packages/ && make check`), encoding "run CI before push" as
   enforcement rather than discipline.
3. **Universal2 DMG built in CI** — the macOS app is one artifact for both Apple
   Silicon and Intel. Bundled Node + native modules (`pty.node`, `impit.node`)
   are `lipo`'d from both arches (built on separate runners). Hard-gated by the
   bundle smoke test and a **real Intel runner** that runs the smoke test
   natively on x64. `release.yml` publishes server tarballs + DMG + ZIP + blockmap
   + `latest-mac.yml` + SHA256SUMS, with the GitHub Release body taken from the
   CHANGELOG.
4. **Code signing + notarization** — Developer ID cert + App Store Connect Team
   API key (`.p8`), `notarize: true` (notarytool, auto-staple). Eliminates the
   Gatekeeper warning.
5. **electron-updater** — in-app auto-update from GitHub Releases, delta downloads
   via blockmap, stable/beta channels.
6. **SLSA provenance** (`actions/attest-build-provenance`, SLSA L2) + this runbook
   (`docs/RELEASE.md`) + this ADR.

**Scope decisions (Terry):**
- **macOS-only Desktop app.** No Linux/Windows desktop. The persistent *server*
  still ships cross-platform (the 4 tarballs + `install.sh` cover Linux + macOS).
- **universal2 from day one** (not per-arch), despite the bundled-Node + native-
  module `lipo` complexity. The mechanism was proven locally before building CI:
  a `lipo`'d fat `.node`/binary loads under both arm64 and x64.
- **changesets over release-please** — explicit per-PR changeset files give
  intentional release control and the `fixed` group matches our lockstep model.

**Rationale:**
- **Fixes version drift structurally** — versions are derived from changesets,
  never hand-edited.
- **The DMG can no longer ship broken** — it's CI-built, smoke-tested, and
  validated on real Intel hardware before any release. This is the structural fix
  for the repeated "ship → broken" cycles.
- **universal2 is the better user experience** — one download, no "which chip do
  you have?" — and electron-updater's feed is simplest with a single artifact.
- **Signing + auto-update are table-stakes** for a product users install and keep.

**Alternatives considered:**
- **release-please** (commit-driven) — rejected: changesets' explicit files +
  `fixed` group fit a lockstep monorepo better, and decouple releases from commit
  message discipline.
- **Per-arch DMGs** — rejected by Terry in favor of universal2, accepting the
  `lipo` work (de-risked locally first).
- **Keep building the DMG locally** — rejected: it's the exact source of the
  unvalidated-artifact problem.
- **semantic-release** — rejected: not monorepo-native; the community monorepo
  plugin is stale.

**Implications:**
- Every user-facing PR now carries a changeset (a small per-PR tax that makes
  releasing fully automatic).
- The Apple Developer Program enrollment ($99/yr) is a hard prerequisite for PRs
  4–5 (signing is required for macOS auto-update to work at all).
- electron-builder stays at 25.1.8 for now (handles universal); bump to 26.x only
  if CI surfaces a universal issue.
- The `validate-dmg.sh` CDP UI test runs `continue-on-error` in CI initially —
  whether Electron+CDP runs on a headless GitHub runner is the one unproven piece;
  it hardens to a gate once confirmed.

**Validation:** universal Node `lipo` (256M fat binary), universal native-module
`lipo` + cross-arch load (real impit arm64+x64), local single-arch DMG build +
full `validate-dmg.sh` end-to-end, `actionlint` clean on all workflows, `make
check` 353/353. CI-only pieces (universal build, Intel native job) babysat through
CI.

**Runbook:** `docs/RELEASE.md`.
