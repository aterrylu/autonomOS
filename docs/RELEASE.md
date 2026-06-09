# Releasing autonomOS

This is the runbook for cutting a release. The pipeline is **changesets-driven**:
you never hand-edit version numbers. Releasing is, in one sentence, **"merge the
Version Packages PR."**

## Mental model

```
PR with a changeset  ──►  merge to main  ──►  bot opens "Version Packages" PR
                                                        │
                                          (accumulates changesets,
                                           bumps versions, writes CHANGELOG)
                                                        │
                                          merge "Version Packages" PR
                                                        │
                                          version.yml auto-tags vX.Y.Z
                                                        │
                                          release.yml builds + publishes:
                                          • 4 server tarballs + SHA256SUMS
                                          • universal2 macOS DMG + ZIP + blockmap
                                          • latest-mac.yml (auto-update feed)
                                          • GitHub Release (body = CHANGELOG section)
```

All five packages (`app`, `cli`, `core`, `dashboard`, `server`) share one
version — they're a `fixed` group in `.changeset/config.json`.

## Day-to-day: adding a changeset

Every PR that changes user-facing behavior includes a changeset:

```bash
bun run changeset
# pick a bump (patch / minor / major), write a one-line summary
```

It writes `.changeset/<name>.md`. Commit it with your PR. For trivial/internal
PRs (CI tweaks, comment fixes) use `bun run changeset --empty`.

Bump guidance for a 0.x product:
- **patch** — bug fixes, refactors, no behavior change
- **minor** — new user-facing features (the common case)
- **major** — breaking changes (rare until 1.0)

You only need to name **one** package in the changeset (conventionally
`@autonomos/app`); the whole fixed group bumps together.

## Cutting a release

1. **Land your feature PRs** (each with a changeset) into `main`.
2. The **Version** workflow opens/updates a PR titled **"chore(release): version
   packages"**. It bumps every `package.json`, regenerates the root
   `CHANGELOG.md`, and lists every change.
3. **Review that PR** — it's your last chance to sanity-check the version bump
   and the changelog wording.
4. **Merge it.** `version.yml` then tags `vX.Y.Z` and pushes the tag.
5. The tag triggers **`release.yml`**, which builds everything and publishes the
   GitHub Release. Watch the run in the Actions tab.

That's it. No manual `npm version`, no manual tag, no manual upload.

> **Requires the `RELEASE_PAT` secret** (see [Secrets](#secrets-github-repo-settings--secrets-and-variables--actions)).
> Without it, GitHub's anti-recursion rule blocks the bot's actions from triggering
> downstream workflows, so steps 3–5 need two manual nudges each release:
> the Version PR's `check` never runs (close + reopen the PR to trigger it), and
> the bot-pushed tag never starts `release.yml` (delete + re-push the tag under
> your own auth: `git push origin :refs/tags/vX.Y.Z && git tag vX.Y.Z <sha> && git push origin vX.Y.Z`).
> Adding `RELEASE_PAT` makes the whole flow truly one-merge.

## What gets built (`release.yml`)

| Stage | Runner | Output |
|---|---|---|
| `build-server` (matrix) | macos-14, macos-15-intel, ubuntu, ubuntu-arm | 4 server tarballs (`install.sh` consumes these) |
| `build-dmg` | macos-14 | universal2 DMG + ZIP + blockmap. **Hard-gated** by the bundle smoke test |
| `validate-intel` | macos-15-intel | mounts the DMG on **real Intel hardware**, runs the smoke test natively (proves the x64 slice executes). **Hard gate** |
| `release` | ubuntu | assembles everything + SHA256SUMS, GitHub Release body = CHANGELOG section |

The macOS DMG is **universal2** — one download runs on Apple Silicon and Intel.
The bundled Node binary and native modules (`pty.node`, `impit.node`) are `lipo`'d
from both arches (see `packages/app/scripts/bundle-node.sh` and
`stage-universal-server.sh`).

## Beta / pre-release

Tag a pre-release version to publish to the beta channel without affecting stable:

```bash
# from a Version PR bumped to e.g. 0.2.0-beta.1, after merge the auto-tag
# produces v0.2.0-beta.1 → release.yml publishes a pre-release.
```

Beta users opt in via the Desktop's Settings (auto-update channel). Stable users
never see beta builds.

## Rolling back

A release is immutable once published, so "rollback" = ship a fix forward OR
re-point users:

- **Bad Desktop build:** publish a new patch release. electron-updater pulls the
  newer `latest-mac.yml`; users auto-update past the bad version.
- **Bad server tarball:** `install.sh` always fetches `releases/latest`. Publish
  a patch, or (emergency) edit the GitHub Release to mark the bad one as a
  pre-release so `latest` points at the prior good one.
- **Never delete a published tag/release** that users may have pulled — fix
  forward.

## Local DMG builds (for testing, not releasing)

```bash
cd packages/app && bash scripts/build-dmg.sh
# single-arch (host), fast. Output → ~/Downloads/autonomOS-<ver>-<sha>-<arch>.dmg
bash scripts/validate-dmg.sh ~/Downloads/autonomOS-<...>.dmg   # full CDP check
```

Local builds are single-arch + unsigned — for validation only. The universal,
signed artifact comes from CI.

## Secrets (GitHub repo settings → Secrets and variables → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | version.yml, release.yml | auto-provided by Actions |
| `RELEASE_PAT` | version.yml | **Makes releases one-merge.** Fine-grained PAT, **this repo only**, scopes: **Contents: Read and write** + **Pull requests: Read and write**. Without it the Version PR and the version tag are bot-created, which GitHub won't let trigger CI / `release.yml` — so each release needs two manual nudges (see [Cutting a release](#cutting-a-release)). version.yml falls back to `GITHUB_TOKEN` when it's absent. *(A GitHub App token via `actions/create-github-app-token` is the short-lived-credential alternative.)* |
| `CSC_LINK` | release.yml (signing) | base64 of the Developer ID Application cert (`.p12`) |
| `CSC_KEY_PASSWORD` | release.yml | the `.p12` password |
| `APPLE_API_KEY` | release.yml (notarization) | base64 of the App Store Connect API key (`.p8`) |
| `APPLE_API_KEY_ID` | release.yml | the key's ID |
| `APPLE_API_ISSUER` | release.yml | the issuer ID |

**Signing + notarization are conditional.** When `CSC_LINK` is present the `.app`
is signed; when the `APPLE_API_KEY` secret is also present it's notarized + stapled
(`build-dmg` enables `--config.mac.notarize.teamId` only then). The `validate-intel`
job asserts the result on real Intel hardware via `spctl --assess` — a signed build
that isn't notarized **fails the gate** (it would still warn on download), so a
release is always either fully unsigned or fully signed+notarized. With **all five**
secrets set, the DMG opens with no Gatekeeper warning. Team ID `39VWFRL3PM` is
hardcoded in `release.yml` (not secret). Without the secrets the build is unsigned
(right-click → Open, or System Settings → Privacy & Security → Open Anyway).

## Troubleshooting

- **Version PR didn't appear** — you merged a PR with no changeset. Add one and
  push; the bot updates on the next push to main.
- **Release build failed on the smoke test** — the bundle is broken (e.g. a
  native-module ABI mismatch). The smoke test is doing its job; fix the bundle.
  See the `build-dmg` job logs.
- **`validate-intel` failed** — the universal DMG's x64 slice doesn't run on real
  Intel. Check `stage-universal-server.sh` lipo'd both arches (the smoke test's
  `SMOKE_EXPECT_UNIVERSAL` slice check should have caught a missing slice first).
- **Notarization failed** — usually an expired/incorrect Apple API key, or the
  app references an entitlement not in `entitlements.mac.plist`. Re-check the
  three `APPLE_*` secrets.

## Reference

- Versioning + changelog mechanics: [`.changeset/README.md`](../.changeset/README.md)
- Architectural rationale: ADR-031 in [`docs/DECISIONS.md`](DECISIONS.md)
