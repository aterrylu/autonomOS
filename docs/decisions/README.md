# Architectural Decision Records

One file per decision: `ADR-NNN-<slug>.md`. The old single-file log
(`docs/DECISIONS.md`) was split here so that parallel PRs stop conflicting on it.
GitHub's file list above shows every ADR by number and title. For a table with
each ADR's date, status and supersession links, run:

```sh
make adr-index        # prints the table (generated from these files; nothing is committed)
```

## Adding a decision

```sh
make adr NEW="Short decision title"   # takes the next free number (main + open PRs), writes a template
```

Fill in every field. `make check` (and CI) rejects a new ADR missing any of
**Date** (YYYY-MM-DD), **Decided by**, **Context**, **Decision**, **Rationale**,
**Alternatives considered** or **Source**. Optional: **Status:** (defaults to
Accepted) and **Supersedes:** ADR-NNN, which feeds the table's supersession
columns. Write `part of ADR-NNN` or `ADR-NNN (part: …)` when only part of it is replaced.

**Number collision?** Two parallel PRs can pick the same number. If CI flags it
on your PR, you're the later one: run `make adr-renumber FILE=docs/decisions/ADR-NNN-….md`.
It moves the file to the next free number and rewrites its header; nothing else
changes. Main doesn't require up-to-date branches, so both PRs can occasionally
merge. Main's CI then goes red with the same message, and whoever merged later runs
the same command in a follow-up PR.

## A PR that still appends to `docs/DECISIONS.md`

Branches opened before the split carry their ADR inside the old file. Move it once:

```sh
git fetch origin && git merge origin/main       # conflicts only in docs/DECISIONS.md
make adr-import REF=HEAD                         # writes your entry to docs/decisions/ADR-NNN-….md
git checkout origin/main -- docs/DECISIONS.md    # keep main's stub
git add docs/decisions docs/DECISIONS.md && git commit --no-edit && make adr-check
```

`adr-import` keeps your number if it's free and otherwise takes the next free one (it
says so; update any references to the old number in your PR). It refuses to guess: an
ADR-like header it can't parse, or a past entry your branch edited in place, is reported
rather than dropped. Already committed the merge? Use `REF=HEAD^1`.

## Rules

- **Append-only.** Never edit or delete a past decision. To reverse one, add a new
  ADR that references it. Migrated entries are hash-locked in
  [`legacy-manifest.json`](legacy-manifest.json), and CI fails on any edit.
- **Historical quirks are kept, not fixed.** Migrated entries keep their exact text,
  including older field formats and header styles (`ADR-073 — …`). A number that
  appears twice in history gets a letter suffix in its FILENAME only: the second
  ADR-029 (`ADR-029-follow-up`) is `ADR-029b-….md`. Letter suffixes are reserved
  for migrated entries; new ADRs are always `ADR-NNN-kebab-slug.md`.
- **Status and supersession** in the `make adr-index` table are derived where
  parseable: a title's "supersedes ADR-X" / "reverses part of ADR-X", or a
  `**Supersedes:**` field. For anything subtler, read the entry.

This file is hand-written. Edit it like any other doc.
