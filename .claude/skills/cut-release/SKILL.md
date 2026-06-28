---
name: cut-release
description: >-
  Cut a new autonomOS version-release end-to-end — verify deploy + test happened
  on forge, merge the changeset-release PR to fire the version+release workflows,
  watch the publish complete, then rewrite the mechanical one-line-per-PR body
  into autonomOS's themed/emoji format (the v0.3.0 style Terry approved) and
  apply it via `gh release edit`. Use when asked to "cut a release", "cut v0.x",
  "do a release", "ship a release", or "make the release notes friendly". The
  body-rewrite step alone is safe to re-run on an already-published release.
  Does NOT touch CHANGELOG.md.
---

# /cut-release — version-cut + friendly release notes

autonomOS releases are a multi-step pipeline, not one click. This skill owns the
whole sequence. **The published GitHub Release is the canonical artifact users
get — auto-update users start receiving it within minutes — so the version *must*
be validated on forge before it is cut.**

## ⚠️ The order matters. Read this once before you ever run this skill.

> ### **`make deploy` → test on forge → merge changeset-release PR → friendly body**
>
> 1. **`make deploy`** — rsync the current `main` to forge (autonomOS's
>    production-like staging environment). Safe to run from a CC session
>    (rsync-only; not `make prod`).
> 2. **Test on forge** — verify the build is healthy. Spawn agents, exercise the
>    features that landed in this release. **A bug found *after* the GitHub
>    Release publishes can only be fixed by shipping `v0.x.(y+1)`** — auto-update
>    users have already started receiving the broken artifact.
> 3. **Merge the changeset-release PR** (the open `chore(release): version
>    packages` PR, typically authored by the changesets bot, e.g. `#245`). This
>    fires the **Version** workflow (bumps `packages/*/package.json`, regenerates
>    `CHANGELOG.md`, tags `v<version>`), which triggers the **Release** workflow
>    (universal DMG build → sign → notarize → publish GitHub Release + assets).
>    Typical wall-clock: ~10–15 min unless Apple notary stalls (rare; see memory
>    `project_mac_signing_notary` for the 85-min stall case).
> 4. **Rewrite the body** — read the mechanical floor that CI published, produce
>    the themed/emoji ceiling, apply via `gh release edit`. (Procedure below.)
>
> Steps 1 and 2 are not optional. The `v0.4.0` release on 2026-06-28 was cut
> without a forge deploy + test pass (operator confused "cut a release" with
> "fire the pipeline") and this section exists so that mistake stops costing.
> If you are running `/cut-release` and aren't sure whether steps 1 and 2
> happened: **STOP and ask the user.**

## Two layers of release notes (ADR-044)

- **Floor of correctness** — the mechanical, one-line-per-PR body that
  `scripts/sync-changelog.ts` consolidates into `CHANGELOG.md` and
  `scripts/release-notes.ts` extracts. CI publishes this automatically when the
  Release workflow runs. It is always correct and never themed.
- **Ceiling of friendliness** — the themed/emoji body Terry approved for
  `v0.3.0`. **That is what step 6 below produces.**

The model doing the friendly rewrite is **the Claude Code session running this
skill** — there is no API key, no Anthropic SDK call, no CI step for the rewrite.
You read the mechanical body, transform it, and apply it to the live release.
Because the mechanical floor already shipped from CI, the rewrite is a safe,
reversible *enhancement* of an already-correct release body.

> **The friendly-rewrite spec is [`canonical-example.md`](./canonical-example.md).**
> Read it in full before writing anything. It is the exact `v0.3.0`
> mechanical→friendly pair. Match its structure, density, and tone. Do not try to
> be cleverer than the example — consistency with it IS the goal.

**Preconditions:** `gh` must be authenticated (`gh auth status`) and `bun`
available. If `gh` isn't logged in, the step-2 commands fail with an auth error —
that is an auth problem, NOT a missing release; don't tell the user to publish one.

---

## Procedure

### 1. Verify forge was deployed AND tested — STOP if not

This is the gate that prevents the `v0.4.0` mistake from recurring. **Before
firing the release pipeline, confirm with the user:**

1. **Was `make deploy` run since the last main commit?** If no → `make deploy`
   first (you can run it; it's rsync-only, safe from a CC session).
2. **Did the user test the build on forge?** If no → STOP and ask the user to
   test before proceeding. Do NOT merge the changeset-release PR for them.
3. If both yes → proceed to step 2.

> If the user invoked `/cut-release` **only to friendly-rewrite an already-cut
> release** (the release tag already exists on GitHub), skip step 5; the
> body-rewrite (steps 6–10) is safe to re-run on an already-published release.

### 2. Determine the version and tag

- If the user gave a version/tag, use it. Otherwise derive the version from the
  next-free version in the open `chore(release): version packages` PR (the
  changeset-release PR — see step 5). Once the release is cut, the version is
  also readable from `packages/app/package.json` (`.version`).
- The **bare version** is e.g. `0.4.0`. The **tag** is `v0.4.0` (version with a
  leading `v`). Keep them distinct — `release-notes.ts` wants the bare version;
  `gh` wants the tag.

### 3. Confirm release state (or expect to cut it)

```bash
gh release view "v<version>" --json tagName,isDraft,body
```

- **Release exists + published** → you're in the body-rewrite-only path. Skip to
  step 6.
- **Release does not exist** → you're in the full-cut path. Proceed to step 4.

### 4. Find the changeset-release PR

```bash
gh pr list --head changeset-release/main --state open --json number,title,mergeStateStatus,reviewDecision
```

There should be exactly one open `chore(release): version packages` PR (typically
authored by the changesets bot). Confirm:

- `reviewDecision` is `APPROVED` (nox-0x or Terry approved).
- `mergeStateStatus` is `CLEAN` (no required-check failures or unresolved threads).

If either gate isn't met, STOP and surface the gap to the user — don't merge an
unready release PR.

### 5. Merge the changeset-release PR → fire the pipeline

```bash
gh pr merge <pr-number> --squash --delete-branch
```

This triggers two workflows in sequence:

1. **Version** (on push to `main`): bumps `packages/*/package.json` versions,
   regenerates root `CHANGELOG.md`, commits the version-bump, pushes the
   `v<version>` tag.
2. **Release** (on push tag `v<version>`): builds the universal DMG, signs +
   notarizes, publishes the GitHub Release with DMG + server tarballs +
   `latest-mac.yml` (auto-update manifest) + `SHA256SUMS`.

Watch both to completion before proceeding. Background-watcher pattern:

```bash
gh run watch <version-run-id> --interval 60 &   # Version (~1-2 min)
# Then, after Version completes and tag is pushed:
gh run watch <release-run-id> --interval 60     # Release (~10-15 min)
```

If the Release workflow takes >30 min, suspect Apple notarization stall (see
memory `project_mac_signing_notary` — diagnose via `notarytool` directly,
85-min+ stalls are real). Don't proceed to step 6 until the GitHub Release is
visible at `gh release view "v<version>"`.

> After the Release workflow completes, **`git pull origin main`** in your local
> checkout. The Version workflow committed the version-bump + regenerated
> `CHANGELOG.md` on `main`; step 6's `bun scripts/release-notes.ts` reads the
> local `CHANGELOG.md`, so a stale local copy will produce
> `[release-notes] no CHANGELOG section found for v<version>`.

### 6. Get the mechanical body (the input — never hand-type it)

Run, from the repo root (**pass the bare version, NOT the `v` tag** — the script
matches a `## [<version>]` heading and `exit(1)`s if given `v0.4.0`):

```bash
bun scripts/release-notes.ts <version>
```

This prints the exact mechanical floor for that version — the same text CI
published. **This is your input. Do not reconstruct it from `git log`, the PR
list, or the live release body** — `release-notes.ts` is the single source of
truth, and using it guarantees you operate on the same PR set CI shipped.

> **Sanity-check the input is complete.** The step-4 guardrail guarantees your
> friendly body matches this mechanical input exactly — but it cannot tell whether
> the *input itself* is complete. That is the floor's responsibility (ADR-044).
> Cross-check the PR count against the release's actual contents:
> ```bash
> gh release view "v<version>" --json body --jq '.body' | grep -coE '#[0-9]+'   # PRs CI saw
> bun scripts/release-notes.ts <version> | grep -coE '#[0-9]+'                    # PRs you got
> ```
> If the mechanical body is far sparser than the release actually contains, STOP
> and flag it. Do **not** reconstruct the missing PRs yourself — a thin mechanical
> body means `sync-changelog.ts` under-collected, an upstream floor bug to report,
> not something the ceiling should paper over. (Releases predating PR #244 — e.g.
> `v0.3.0` — have a known-incomplete committed `CHANGELOG.md` section for this
> reason.)

### 7. Transform mechanical → friendly, into a temp file

Following [`canonical-example.md`](./canonical-example.md), produce the friendly
body and **write it to a temp file** — that file is the single artifact you check
in step 8 and apply in step 10:

```bash
FRIENDLY="$(mktemp)"   # write your finished friendly body here
```

The transformation:

1. **Lede** — one short paragraph naming the release's headline themes (what a
   user would most want to know landed).
2. **Themed `## ` sections, each with a leading emoji** — group PRs by *what the
   work does for the user*, NOT by changeset severity. Related PRs cluster
   together (all the Codex work, all the usage-limit work) regardless of whether
   they were minor or patch. Order sections by importance, headline themes first.
3. **One bullet per PR**, in this exact shape:
   ```
   - <emoji> **[#NNN](https://github.com/aterrylu/autonomOS/pull/NNN) — Short imperative title.** One or two sentences of concrete, friendly explanation: what it does and why it matters.
   ```
   - The visible `#NNN` and the `/pull/NNN` in the URL **must be the same number**
     (the step-4 check verifies this — a mismatched link is as bad as a dropped PR).
   - Drop the `sha` and the raw conventional-commit prefix; rewrite the title into
     plain, user-facing language.
   - Call out **breaking changes** explicitly in the prose (see `#220` in the
     example: "Breaking change: …").
4. **Footer** — a `---` then the fixed boilerplate footer (see step 9).

Reorder freely by theme; the mechanical input's severity grouping and PR ordering
do NOT constrain the friendly output. The ONE thing that must survive is the set
of PRs (next step).

### 8. ⛔ Guardrail self-check — MANDATORY before applying

This is the load-bearing invariant. The mechanical floor exists because a prior
bug silently dropped 20 of 21 PRs from a release body (ADR-044); the friendly
ceiling must NOT reintroduce that failure.

Run this **hard** check against `$FRIENDLY` (the file from step 7). It verifies
the PR set survived AND that every link points where its text says:

```bash
mech=$(bun scripts/release-notes.ts <version> | grep -oE '#[0-9]+' | sort -u)
# Visible #NNN tokens in the friendly body must equal the mechanical set:
txt=$(grep -oE '#[0-9]+' "$FRIENDLY" | sort -u)
# Link targets /pull/NNN must ALSO equal the mechanical set (catches wrong hrefs):
url=$(grep -oE '/pull/[0-9]+' "$FRIENDLY" | grep -oE '[0-9]+' | sed 's/^/#/' | sort -u)
if [ "$mech" = "$txt" ] && [ "$mech" = "$url" ]; then echo "PASS — every PR preserved"; else
  echo "STOP — PR set mismatch:"
  echo " visible #NNN missing:"; comm -23 <(echo "$mech") <(echo "$txt")
  echo " visible #NNN invented:"; comm -13 <(echo "$mech") <(echo "$txt")
  echo " link /pull/NNN missing:"; comm -23 <(echo "$mech") <(echo "$url")
  echo " link /pull/NNN wrong/invented:"; comm -13 <(echo "$mech") <(echo "$url"); fi
```

`PASS` = proceed. Anything else = a PR was dropped, invented, or mislinked → **do
NOT run `gh release edit`.** Fix the body and re-check, or stop and report.

Also confirm (hard):
- **≥1 themed `## ` section header.**
- **Footer present verbatim** (step 9).
- **No rogue HTML / scripts** — no `<script`, no raw HTML tags beyond the inline
  `<textarea>`-style spans that legitimately appear inside backticks.

Soft check (investigate, don't auto-STOP): the friendly body should be longer than
the mechanical (it adds prose) but not absurdly so — very roughly 1.5×–6× the
mechanical character count. Wildly outside that range is a smell worth a look, not
an automatic failure.

### 9. The fixed footer (reproduce verbatim)

Stable boilerplate every release. Only the parenthetical version in the
auto-update line changes — it names the **previous** released version, so existing
desktop users know their build self-updates:

```markdown
---

📦 **Install:** `curl -fsSL https://raw.githubusercontent.com/aterrylu/autonomOS/main/scripts/install.sh | sh && autonomos start`
🖥️ **Desktop app:** download the universal DMG from the assets below
🔄 **Auto-update users (v<PREV>):** the desktop app will update itself on next launch

Thanks for using autonomOS! 💛
```

`<PREV>` = the release immediately before this one. Derive it from
`gh release list --limit 5` (it lists newest-first; `<PREV>` is the entry below
`v<version>`). For the `v0.3.0` example the value was `v0.2.0`.

### 10. Apply

> **This step encodes the current decision: apply directly + reversible.** It is
> intentionally isolated so it's a one-block change if the invocation model
> changes (e.g. output-only, or agent-automated). See "Configuration" below.

1. The finished friendly body is already in `$FRIENDLY` (step 7).
2. **Show the user the full friendly body** and the step-8 guardrail result
   (the `PASS` line, footer present, etc.).
3. Apply it to the live release:
   ```bash
   gh release edit "v<version>" --notes-file "$FRIENDLY"
   ```
4. Confirm: print `gh release view "v<version>" --web` (or the release URL) so the
   user can eyeball the rendered result. `gh release edit` is fully reversible —
   re-run `/cut-release` or edit again if anything looks off.

---

## Tonal guardrails

- **Match `canonical-example.md`'s voice**: warm, concrete, user-facing. Lead with
  what changed for the user, not the implementation.
- **Footer is fixed boilerplate** — reproduce verbatim (step 9).
- No emoji or phrasing is banned by default. *(If Terry specifies tonal
  constraints — emojis to avoid, phrasings to avoid — add them here; this is the
  one section meant to absorb those without touching the procedure.)*

## Configuration / current decisions

These are the choices baked into the procedure above; they're called out so a
future change is a small, obvious edit rather than a hunt:

- **Deploy + test gate (step 1) = mandatory.** This is the gate that prevents
  the `v0.4.0` mistake from recurring. To soften (e.g. skip the gate for
  hotfix releases), add an explicit `--skip-validation` argument and document
  when it's permitted.
- **Apply mode = apply-directly** (step 10 runs `gh release edit`). To make
  the skill output-only, replace step 10's `gh release edit` call with "print
  the body for the user to paste" and stop.
- **Invocation = manual** — a human or agent runs `/cut-release <version>`.
  To automate, have an autonomOS agent invoke this skill on a "main has open
  changeset-release PR + forge tested" signal; the skill body does not change.

## Notes

- Works from the main repo or any worktree — all paths are repo-relative and
  `scripts/release-notes.ts` reads from the repo root.
- Never edits `CHANGELOG.md` — that is the committed mechanical archive (the
  floor). This skill only edits the GitHub Release body (the ceiling).
- Never touches `scripts/sync-changelog.ts` or `scripts/release-notes.ts` — it
  consumes their output, it does not modify them.
