# Releasing autonomOS

This is the runbook for cutting a release. The pipeline is **changesets-driven**:
you never hand-edit version numbers. Releasing is, in one sentence, **"merge the
Version Packages PR."**

autonomOS ships as a **server** — four per-platform tarballs consumed by
`install.sh`. (The Electron desktop app was cut in ADR-051; the canonical client
is the browser + PWA, and there is no DMG/signing/notarization in the pipeline.)

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
                                          • GitHub Release (body = CHANGELOG section)
```

All four packages (`cli`, `core`, `dashboard`, `server`) share one
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
`@autonomos/server`); the whole fixed group bumps together.

## Cutting a release

1. **Land your feature PRs** (each with a changeset) into `main`.
2. The **Version** workflow opens/updates a PR titled **"chore(release): version
   packages"**. It bumps every `package.json`, regenerates the root
   `CHANGELOG.md`, and lists every change.
3. **Review that PR** — it's your last chance to sanity-check the version bump
   and the changelog wording.
4. **Merge it.** `version.yml` then tags `vX.Y.Z` and pushes the tag.
5. The tag triggers **`release.yml`**, which builds the server tarballs and
   publishes the GitHub Release. Watch the run in the Actions tab.

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
| `release` | ubuntu | assembles the tarballs + SHA256SUMS, GitHub Release body = CHANGELOG section |

Each tarball is a self-contained per-platform server bundle (the dashboard is
embedded into the bundle at build time). The reusable `build-server` job lives in
`reusable-server-build.yml`.

## Beta / pre-release

Tag a pre-release version to publish a GitHub pre-release without affecting
stable:

```bash
# from a Version PR bumped to e.g. 0.2.0-beta.1, after merge the auto-tag
# produces v0.2.0-beta.1 → release.yml publishes a pre-release.
```

`install.sh` always fetches the stable `releases/latest`, so a pre-release's
tarballs never reach stable users unless they explicitly download them.

## Rolling back

A release is immutable once published, so "rollback" = ship a fix forward OR
re-point users:

- **Bad server tarball:** `install.sh` always fetches `releases/latest`. Publish
  a patch, or (emergency) edit the GitHub Release to mark the bad one as a
  pre-release so `latest` points at the prior good one.
- **Never delete a published tag/release** that users may have pulled — fix
  forward.

## Secrets (GitHub repo settings → Secrets and variables → Actions)

| Secret | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | version.yml, release.yml | auto-provided by Actions |
| `RELEASE_PAT` | version.yml | **Makes releases one-merge.** Fine-grained PAT, **this repo only**, scopes: **Contents: Read and write** + **Pull requests: Read and write**. Without it the Version PR and the version tag are bot-created, which GitHub won't let trigger CI / `release.yml` — so each release needs two manual nudges (see [Cutting a release](#cutting-a-release)). version.yml falls back to `GITHUB_TOKEN` when it's absent. *(A GitHub App token via `actions/create-github-app-token` is the short-lived-credential alternative.)* |

## Troubleshooting

- **Version PR didn't appear** — you merged a PR with no changeset. Add one and
  push; the bot updates on the next push to main.
- **Release build failed** — a server bundle didn't build for one of the four
  platforms (e.g. a native-module ABI mismatch). See the `build-server` job logs
  for the failing target.
- **A platform's tarball is missing from the Release** — check that the
  `build-server` matrix leg for that target succeeded and uploaded its artifact.

## Reference

- Versioning + changelog mechanics: [`.changeset/README.md`](../.changeset/README.md)
- Consolidated release notes: ADR-044 in [`docs/DECISIONS.md`](DECISIONS.md)
- Always-on server lifecycle: ADR-050; Electron desktop cut: ADR-051
