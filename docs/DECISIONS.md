# Architectural Decision Records → [`docs/decisions/`](decisions/)

This log moved: **every decision is now its own file** in
[`docs/decisions/`](decisions/), named `ADR-NNN-<slug>.md`, with a generated index in
[`docs/decisions/README.md`](decisions/README.md). ADR numbers did not change, so
existing "ADR-NNN" references (code comments, PRs, notes) still point at the same
decision: open `docs/decisions/ADR-NNN-*.md`.

- **Add a decision:** `make adr NEW="Short title"`. Do not append here; CI rejects
  new entries in this file.
- **Have an open PR that appended an entry here?** Run `make adr-import REF=HEAD`
  while merging main, then keep main's version of this file. See the steps in
  [`docs/decisions/README.md`](decisions/README.md).

The migrated entries are byte-for-byte what this file held (verified by
`scripts/decisions.test.ts` against the SHA-256 in
[`legacy-manifest.json`](decisions/legacy-manifest.json)).
