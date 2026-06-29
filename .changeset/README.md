# Changesets

This folder is the release machinery for autonomOS. Every PR that changes
user-facing behavior should include a **changeset** — a short markdown file
declaring the version bump and a one-line summary that lands in the changelog.

## How to add one

```bash
bun run changeset
```

Answer the prompts (pick a bump kind, write the summary). It writes a file
like `.changeset/wise-otters-dance.md`:

```markdown
---
"@autonomos/server": minor
---

Add per-provider permission modes to the agent spawn flow.
```

## Lockstep versioning

All four packages (`cli`, `core`, `dashboard`, `server`) are a **fixed
group** — they always share one version. You only need to name **one** package
in the changeset; the whole group bumps together. The `server` package is the
conventional one to name since the server is the user-facing product.

## Bump kinds (semver)

- **patch** — bug fixes, internal refactors, doc/CI changes with no behavior change
- **minor** — new user-facing features (the common case for a 0.x product)
- **major** — breaking changes (rare until 1.0)

## What happens next

1. You merge your PR (with its changeset) into `main`.
2. The **Version** workflow opens/updates a "Version Packages" PR that
   accumulates all pending changesets, bumps every package, and regenerates
   `CHANGELOG.md`.
3. Merging that PR tags `vX.Y.Z` and triggers the release build.

So **releasing is just "merge the Version Packages PR"** — no manual version
edits, ever. See [`docs/RELEASE.md`](../docs/RELEASE.md) for the full runbook.

## Trivial PRs

Pure-internal changes (CI tweaks, test-only, comment fixes) can use an empty
changeset so the "has a changeset?" check passes without forcing a version bump:

```bash
bun run changeset --empty
```
