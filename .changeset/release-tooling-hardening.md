---
"@autonomos/server": patch
---

Release-tooling hardening from the v0.5.0 retrospective: the changeset-check CI gate now BLOCKS PRs that change production source (`packages/*/src`, tests excluded) without a changeset (`bun run changeset --empty` stays the opt-out; ADR-069); `sync-changelog` detects and loudly warns when distinct changesets collapse onto one PR key (the retroactive-changeset attribution bug that folded 5 backfilled entries into 1 on #275) and supports a `<!-- pr: NNN -->` body marker so a retroactive changeset can attribute itself to the PR it documents; the /release skill's footer no longer advertises the desktop DMG + auto-update (cut in #273/ADR-051).
