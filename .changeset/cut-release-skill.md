---
"@autonomos/server": patch
---

Rename the `/release` skill to `/cut-release` and broaden it to cover the full
version-cut workflow: verify `make deploy` + forge test happened first, then
merge the changeset-release PR to fire the Version + Release workflows, watch
the publish complete, then apply the themed/emoji body via `gh release edit`.
Adds a mandatory step-1 gate that prevents the `v0.4.0`-class mistake of cutting
a release before validating the build on forge.
