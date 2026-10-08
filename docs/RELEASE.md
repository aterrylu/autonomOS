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

- **Upgrades never break existing auth.** No migration, upgrade, reinstall,
  or unit re-render may change what token the daemon accepts without
  migrating it or saying so loudly (invariant set by Terry after the v0.6.0
  forge lockout; pinned by `scripts/install-source-env.test.ts`). Every
  migration/upgrade/install PR must carry a **"USER-VISIBLE BREAKAGE"**
  section in its body — itemized, or explicitly empty with the reasoning —
  and anything auth-touching in that section is a hard human gate before
  merge.
- **No irreversible migrations** (ADR-105). A release that bumps the agent-record format (`AGENT_SCHEMA_VERSION`) must keep the pre-update snapshot sufficient to go back, keep older versions refusing newer records loudly (the store's schema guard), and its GitHub release body MUST contain the marker `<!-- autonomos:storage-format-change -->` so the in-app update warns before the click. The `/release` step adds it; check the changesets for a schema bump before cutting.
- **Main's CI must be green at the tagged commit** (ADR-149). PRs don't have to be up to date with main any more, so a squash can land a combination no PR run tested. `test.yml`, `e2e.yml` and `test-install.yml` also run on pushes to main, and `release.yml`'s `main-ci` job waits, up to an hour, for those runs on the tagged commit and refuses to publish unless all three passed. If main is red, fix it forward (or re-run a flaky job), then re-run the release workflow. Never skip the gate.
- **The attest step is load-bearing** (ADR-126). The in-app update and `autonomos upgrade` verify each downloaded tarball's Sigstore build-provenance attestation. They expect the signer `https://github.com/<repo>/.github/workflows/release.yml@refs/tags/v<version>` and a SLSA statement that names the tarball's sha256. So:
  - Keep `actions/attest-build-provenance` over `release/autonomos-*.tar.gz` in `release.yml`.
  - **Renaming `release.yml`, moving the attest step, or renaming or transferring the repo needs TWO releases.** The check runs in the version that is ALREADY installed. So first ship a release whose verifier also accepts the new signer (`expectedSigner` in `server/src/provenance.ts`). Only the release after that may be signed by the new name. Changing both in one release makes every existing install **refuse** that update and every later one, as "signed by a different workflow". The only way out would be `AUTONOMOS_SKIP_PROVENANCE=1` on each machine.
  - **Cut every release from a commit on `main`** (ADR-128), with `packages/server/package.json` at the tag's version. Installers and updaters check both: a build from a commit that isn't on main is refused as invalid, and a bundle whose version differs from its tag is refused outright.
  - Never re-upload a tarball by hand. Its digest would no longer match the attestation, and every update to that release would be **refused** as invalid.
  - **A release that ships without an attestation can't be installed.** Existing installs postpone it ("couldn't be confirmed… try again later"), and that never clears, because the record will never appear. New installs refuse it, since `install.sh` fails closed on anything but a verified record. If the attest step fails, fix it and cut a new release; never ask users to set `AUTONOMOS_SKIP_PROVENANCE`.
  - `install.sh` runs `scripts/verify-provenance.mjs`, a single-file build of the same verifier, and pins its sha256. After changing `server/src/provenance.ts` or bumping a `@sigstore/*` dependency, run `make verifier` and commit both files: `make check` fails until you do. The site deploy ships both together and then checks the live pin.
- **Declare what users would feel, not changelog "breaking changes"** (ADR-105). The in-app update shows a pre-click warning ONLY for a structured marker in the GitHub release body (an HTML comment, invisible on GitHub). It never reads prose, so writing "Breaking change" in the notes shows nothing. Two markers:
  - `<!-- autonomos:agents-may-not-resume -->`. Set it when an agent spawned by the previous version might not reopen under this one. Examples: a change to the provider resume argv or flags we pass (`--resume`, `codex resume --remote`, `--session-id`), to where a CLI's saved sessions or rollouts are looked up (the resume pre-flight, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` handling), to agent-record fields the respawn reads, or a minimum CLI version bump that drops a flag older sessions need. The dashboard then says: "Some agents may not reopen after this update. If one doesn't, Restore v<old> brings it back, together with the snapshot from before the update."
  - `<!-- autonomos:storage-format-change -->`. Set it for an agent-record format bump (see the bullet above). The warning is that changes made after updating won't carry back if you restore.
  - Don't mark API, route, or flag removals, UI changes, or anything else that doesn't touch a running agent's ability to reopen. The notes themselves carry those. When in doubt, ask whether a user would lose an agent after clicking Update. If not, no marker.
- **Never bind, tunnel, or touch `localhost:3100`** — that is the operator's
  live production server.
- **Never run `scripts/test-install.sh` or any `autonomos` service verb
  (`stop`/`restart`/`install-service`/`uninstall-service`/`upgrade`/`rollback`)
  on the operator's LOCAL machine.** CI is the only verifier for those (see
  ADR-081 for the three incidents behind this). Forge-side service operations
  through the documented deploy/install paths are fine — that is what they do.
- Squash-merge only; never `--admin`; resolve all review threads before merge.

## Phase 0 — pre-cut validation on forge (MANDATORY for every cut)

**Every cut — patch releases included — deploys and tests the actual
CANDIDATE as a running instance before Terry's go. No shape-aware skipping,
no "the delta is small" exemptions** (Terry's standing rule, 2026-08-26:
"every time before we cut a release we need to actually deploy and test
it"). Green CI is necessary, never sufficient — the candidate must RUN.
Two tiers; pick deliberately and say which you ran in the report:

- **Default — isolated candidate instance** (what recent cycles ran):
  fresh clone at the candidate SHA on forge, own config dir, own port
  (never 3100), boot clean via ITS rotating log (`<cfg>/logs/autonomos.log`),
  exercise the release's changed surface plus a spawn, browser pass against
  `http://forge:<candidate-port>`, tear it down by exact PID, and prove the
  live install untouched before/after. Forge's live daemon and agents are
  never restarted.
- **Deeper tier — deploy over the live install** (only when the delta
  warrants exercising live-install behaviors: resume-across-restart,
  migration/upgrade paths, supervisor-unit changes): the shape-aware deploy
  below. This RESTARTS the live forge daemon — its agents restart and
  resume (expected, ADR-049) — so use it knowingly, not by default. The
  smoke list below (live log, live `/api/system/version`, forge `.env`
  token, `http://forge:3100` browser pass) belongs to THIS tier.

The report to Terry states what ran and why that coverage is sufficient
for the delta — he judges coverage, not just "green".

For the deeper tier, validate **current main** on forge BEFORE cutting. Do
not migrate or adopt anything pre-cut — validation uses whatever install
shape forge already has.
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

**Permanent checklist item (#376): "MCP tools work from a spawned agent on
a BUNDLE-shape install."** The channel-server bridge is a separately-packed
artifact — source-mode installs resolve its deps against the repo and hide
bundle-only breakage, which is exactly how v0.6.1 shipped with a
fleet-dead MCP for every bundle user. The unit + install-CI tests guard the
artifact; Phase 0 verifies the end shape when a bundle-shape instance is in
the validation mix.

**Version-gated removals: check before every cut.** Some compatibility
shims exist only to carry running agents across ONE upgrade. Each has a
release it becomes removable in. Before cutting, go through this list. For any
item that is due, open its removal PR (it merges before the cut); then tick
it or delete it here. Leave an item that isn't due yet alone: removing it
early strands agents mid-upgrade.

- [ ] **`/ws/gateway` operator `?token=` fallback** (ADR-129, security audit
  V3). Due in **the release AFTER the first release that contains #457
  (070a2c4b8f)**. If this cut is the first to contain #457, it is NOT due yet.
  Channel servers started before V3 still authenticate the gateway upgrade
  with the operator token until their agent respawns. Removal: in
  `packages/server/src/routes/agentApi.ts`, `gatewayUpgradeAuth` becomes
  "agent credential or 401" (drop the `operatorAuth` branch and its caller's
  `requireAuth` argument in `run.ts`), and the "old channel server: operator
  `?token=` still works" case in `agent-api.test.ts` flips to expect a refusal.
  Plan: `~/.claude/plans/gateway-ws-hardening-followups.md`.

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
  3. The script writes the source-mode `install.json`, **migrates
     `AUTONOMOS_TOKEN` from the old tree's `.env`** (auth-continuity
     invariant, see the env-migration ADR — other `.env` overrides are
     deliberately dropped and listed by name in the output; copy any you
     still need into the clone's `.env`), then hands off to `make prod`,
     which re-renders the supervisor unit **pointing at the new clone** and
     restarts onto it (prod shape forces `--port=3100`). The `$configDir`
     state (`~/.autonomos`: sessions, logs, token FILE) is untouched by
     either tree — but note the daemon's *effective* token is the `.env`
     value when one exists, which is exactly why the migration carries it.
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
- Consolidated release notes: ADR-044 in [`docs/decisions/`](decisions/README.md)
- Always-on server lifecycle: ADR-050; Electron desktop cut: ADR-051
