---
"@autonomos/server": patch
---

fix(upgrade): source installs only move to release tags that are on main

A `vX.Y.Z` tag is only a name, and anyone with push access could put one on a commit that never went through review. The source-mode updater picked the highest tag and ran that commit's build, so an off-main tag would execute on every source install that upgraded.

- `autonomos upgrade` in source mode now considers only tags contained in `origin/main`. A higher tag that isn't on main is ignored, and pinning to one is refused with a message saying why.
- `scripts/install-source.sh` applies the same rule to its default tag and to `--ref`.
- Both refuse to proceed, with a message saying how to fix it, if the clone has no `origin/main` to check against.
- The release workflow refuses to publish a commit that isn't on main.
