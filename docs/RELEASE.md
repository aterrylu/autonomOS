# Releasing autonomOS

This is the runbook for cutting a release. Two parts:

- **Part 1 — the release cycle**: the operational loop a release engineer runs
  each cycle (pre-cut validation on forge, the cut, post-cut rollout). Written
  so **any agent (or Terry) can execute it in an emergency**, even though a
  standing release engineer normally owns the mechanical steps.
- **Part 2 — release mechanics**: the changesets pipeline, what gets built,
  secrets, recovery, and troubleshooting. The pipeline is **changesets-driven**:
  you never hand-edit version numbers. Releasing is, in one sentence, **"merge
  the Version Packages PR."**

autonomOS ships as a **server** — four per-platform tarballs consumed by
`install.sh`. (The Electron desktop app was cut in ADR-051; the canonical client
is the browser + PWA, and there is no DMG/signing/notarization in the pipeline.)

Division of labor: **Terry** holds go/no-go, visual QA, and anything that runs a
service verb on his local machine; **TeamLead** gates cross-lane changelog
completeness; the **release engineer** does everything else.

---

# Part 1 — the release cycle

## Standing constraints (non-negotiable)

- **Never bind, tunnel, or touch `localhost:3100`** — that is the operator's
  live production server.
- **Never run `scripts/test-install.sh` or any `autonomos` service verb
  (`stop`/`restart`/`install-service`/`uninstall-service`/`upgrade`/`rollback`)
  on the operator's LOCAL machine.** CI is the only verifier for those (see
  ADR-081 for the three incidents behind this). Forge-side service operations
  through the documented deploy/install paths are fine — that is what they do.
- Squash-merge only; never `--admin`; resolve all review threads before merge.

## Phase 0 — pre-cut validation on forge

Validate **current main** on forge BEFORE cutting. Do not migrate or adopt
anything pre-cut — validation uses whatever install shape forge already has.
**Check the shape first** (`cat <tree>/install.json` on forge, or note that
`/api/system/version` reports `installMode`), then deploy main by the matching
path:

- **rsync shape** (no `install.json`; tree at `~/autonomOS` via `make deploy`):
  `git pull` on clean main locally, then `make deploy` (`DEPLOY_HOST` from
  `.env`). Do **not** pass `BIND_HOST` unless deliberately changing the remote
  bind — an empty value would blank the remote's own setting. The remote
  `make prod` re-renders the unit and restarts the forge daemon; live agents on
  forge restart and resume (expected, ADR-049).
- **managed-clone shape** (`install.json` with `mode: "source"`, clone at
  `~/autonomos` — note the different path from the rsync tree; on forge the FS
  is case-sensitive, so they are distinct trees): do NOT `make deploy` — it
  would build a second copy at `~/autonomOS` that the supervisor ignores, and
  the validation would silently test nothing. Instead, on forge:
  `git -C ~/autonomos fetch origin && git -C ~/autonomos checkout origin/main
  && make -C ~/autonomos prod`. This leaves the clone detached off-tag —
  expected mid-validation; the post-cut `autonomos upgrade` (Phase 2) checks
  out the release tag and restores the managed state. (`autonomos upgrade`
  itself can't do this step: it only moves between release tags.)

Then smoke, on forge over ssh:

- rotating log clean: `~/.autonomos/logs/autonomos.log` (read the real log,
  not a shell redirect);
- `autonomos --version`; `/api/system/version` (all fields; `installMode`
  matches the install shape);
- on an rsync/dev tree, `autonomos upgrade` must REFUSE with instructions
  (exit 2) — verify the failure mode is honest, not silent;
- spawn an agent per provider available on the box; verify a full turn;
- one `once:` schedule targeting a live agent (`target: "agent:<name>"`) —
  verifies scheduler + gateway delivery in one shot;
- `/api/agents/tree` + `POST /api/agents/:id/manager` (org chart),
  `/api/notifications` (no false warnings), usage plugin routes;
- auth note: forge's `.env` sets `AUTONOMOS_TOKEN`, which outranks
  `~/.autonomos/token` — use the `.env` value for API probes.

Browser pass on `http://forge:3100` (Playwright or by hand): login, sidebar
statuses, terminal render + switch + switch-back (keep-alive), mod+K switcher
over a focused terminal, notifications panel, Presets tab, settings popover.
Screenshot the key states for the report.

Report GOOD RELEASE / issues to TeamLead + Terry with the forge URL.
**Terry's go is the gate — do not proceed without it.**

## Phase 1 — cut

1. Terry's go received; any release-blocking PRs merged.
2. **Merge the "Version Packages" PR** (changesets bot, branch
   `changeset-release/main`). TeamLead signs off changelog completeness first.
   The mechanics — and what happens when the `RELEASE_PAT` secret is missing
   (two manual nudges: close+reopen the Version PR so `check` runs; delete +
   re-push the tag under a real identity so `release.yml` fires) — are in
   [Cutting a release](#cutting-a-release) below.
3. Verify: the GitHub release exists, four tarballs + SHA256SUMS attached, tag
   matches `packages/server/package.json`.
4. **Theme the notes**: run the `/release` skill (rewrites the mechanical body
   from `scripts/release-notes.ts` into the approved themed/emoji format via
   `gh release edit`).

## Phase 2 — post-cut forge rollout

- **Forge still on the rsync shape** — migrate to a managed clone **after** the
  cut. The release-first rule: `install-source.sh` pins the newest existing
  `vX.Y.Z` tag, so migrating pre-cut pins the previous version — a silent
  downgrade. Steps, on forge:
  1. Note any `--port`/`--host` baked into the supervising unit
     (`~/.config/systemd/user/autonomos.service`).
  2. Clone FRESH: `bash ~/autonomOS/scripts/install-source.sh` (clones to
     `~/autonomos` at the newest tag; `--ref vX.Y.Z` to pin, `--dir` to
     place). **Never adopt the rsync tree** — `make deploy` ships
     `--exclude .git`, so it is not a clone.
  3. The script writes the source-mode `install.json` and hands off to
     `make prod`, which re-renders the supervisor unit **pointing at the new
     clone** and restarts onto it (prod shape forces `--port=3100`). Config
     dir + token live in `~/.autonomos` — untouched by either tree.
  4. Verify: `autonomos status`; dashboard answers on :3100;
     `autonomos upgrade` reports "Already on the latest version" (that no-op
     also self-heals the supervisor unit, ADR-080). If the fresh install fails
     its health gate, the OLD rsync tree is still on disk: re-run
     `make -C ~/autonomOS prod` to re-point the unit back at it, then
     diagnose.
  5. After a burn-in, delete the old rsync tree at `~/autonomOS`. From then on
     forge upgrades via `autonomos upgrade` / `rollback`; `make deploy` is
     deprecated (prints a warning).
- **Forge already a managed clone** — `autonomos upgrade` on forge (checks out
  the new tag, rebuilds, health-gated restart, unit sync per ADR-080);
  `autonomos rollback` is the undo.
- Verify `/api/system/version` shows the new version and, once the ~daily
  check runs, `updateAvailable: false`.

## Phase 3 — close the cycle

1. Terry restarts his local `:3100` at his convenience (his machine, his verb).
2. Update the release-engineer memory with the cycle outcome; park the session
   (killed, resumable).

## Known wrinkles (check before assuming a bug)

- `.autonomos-bin` wrapper is only re-rendered by an installer re-run; the
  supervisor UNIT self-heals on upgrade (ADR-080), the wrapper does not.
- A resumed Codex agent's channel server registers lazily (on a turn) — a
  "never registered / outbound unavailable" warning ~3 min after a daemon
  restart is usually TRUE and clears on the agent's next turn.
- Scheduled prompts arrive as `agent://Scheduler`; the receiving agent may try
  to reply to it and hold at a permission prompt ("Needs input") — known,
  structural fix pending a product call.
- The post-install connect panel may print the token FILE value even when the
  server's live token comes from `.env` (`AUTONOMOS_TOKEN` outranks the file)
  — trust the `.env` value.

---

# Part 2 — release mechanics

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
