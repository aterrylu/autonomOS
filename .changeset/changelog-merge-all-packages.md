---
"@autonomos/server": patch
---

Fix the release changelog consolidator dropping most changes. The consolidated root CHANGELOG.md (and the GitHub Release body derived from it) sourced only `packages/app/CHANGELOG.md`, so every changeset that didn't list `@autonomos/app` — server-, dashboard-, core-, and cli-only changes — was silently omitted (v0.3.0's release body showed 1 of ~21 changes). The consolidator now merges all per-package CHANGELOGs, deduplicates by PR (keeping the highest severity), and renders one concise line per PR. A new unit test (wired into `make check`) guards the regression, and the script hard-fails if a release section comes out empty while changesets were consumed.
