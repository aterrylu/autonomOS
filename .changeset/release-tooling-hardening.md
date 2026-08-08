---
"@autonomos/server": patch
---

Release-tooling hardening from the v0.5.0 retrospective: the changeset-check CI job now FAILS on PRs that change production source (`packages/*/src`, tests excluded) without a changeset, instead of emitting an always-green warning (`bun run changeset --empty` stays the opt-out; ADR-069); `sync-changelog` detects and loudly warns — with GitHub annotations — when distinct changesets collapse onto one PR key (the retroactive-changeset attribution bug that folded 5 backfilled entries into 1 on #275), pointing at changelog-github's native `pr: NNN` summary override as the remedy; the /release skill's footer no longer advertises the desktop DMG + auto-update (cut in #273/ADR-051).
