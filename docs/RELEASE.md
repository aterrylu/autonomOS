# Release Runbook

The end-to-end cycle for cutting an autonomOS release. Written so **any agent
(or Terry) can execute it in an emergency**, even though a standing release
engineer normally owns the mechanical steps. Division of labor: **Terry** holds
go/no-go, visual QA, and anything that runs a service verb on his local
machine; **TeamLead** gates cross-lane changelog completeness; the **release
engineer** does everything else below.

## Standing constraints (non-negotiable)

- **Never bind, tunnel, or touch `localhost:3100`** — that is the operator's
  live production server.
- **Never run `scripts/test-install.sh` or any `autonomos` service verb
  (`stop`/`restart`/`install-service`/`uninstall-service`/`upgrade`/`rollback`)
  on the operator's local machine.** CI is the only verifier for those (see
  ADR-081 for the three incidents behind this). Forge-side service operations
  through the documented deploy/install paths are fine — that is what they do.
- Squash-merge only; never `--admin`; resolve all review threads before merge.

## Phase 0 — pre-cut validation on forge

Validate **current main** on forge BEFORE cutting. Order matters: forge is
still whatever install shape it was — do not migrate/adopt anything pre-cut.

1. `git pull` on clean main locally; `make deploy` (rsync path; `DEPLOY_HOST`
   from `.env`). Do **not** pass `BIND_HOST` unless deliberately changing the
   remote bind — an empty value would blank the remote's own setting.
   The remote `make prod` re-renders the unit and restarts the forge daemon;
   live agents on forge restart and resume (expected, ADR-049).
2. Smoke, on forge over ssh (all documented in the v0.6.0 cycle transcript):
   - rotating log clean: `~/.autonomos/logs/autonomos.log` (read the real log,
     not a shell redirect);
   - `autonomos --version`, `/api/system/version` (all fields; `installMode`
     matches the install shape);
   - `autonomos upgrade` on a non-marker tree must REFUSE with instructions
     (exit 2) — verify the failure mode is honest, not silent;
   - spawn an agent per provider available on the box; verify a full turn;
   - one `once:` schedule targeting a live agent (`target: "agent:<name>"`)
     — verifies scheduler + gateway delivery in one shot;
   - `/api/agents/tree` + `POST /api/agents/:id/manager` (org chart),
     `/api/notifications` (no false warnings), usage plugin routes.
   - Auth note: forge's `.env` sets `AUTONOMOS_TOKEN`, which outranks
     `~/.autonomos/token` — use the `.env` value for API probes.
3. Browser pass on `http://forge:3100` (Playwright or by hand): login,
   sidebar statuses, terminal render + switch + switch-back (keep-alive),
   mod+K switcher over a focused terminal, notifications panel, Presets tab,
   settings popover. Screenshot the key states for the report.
4. Report GOOD RELEASE / issues to TeamLead + Terry with the forge URL.
   **Terry's go is the gate — do not proceed without it.**

## Phase 1 — cut

1. Terry's go received; any release-blocking PRs merged.
2. **Merge the "Version Packages" PR** (changesets bot, branch
   `changeset-release/main`). TeamLead signs off changelog completeness first.
3. Merging it makes `version.yml` push the `vX.Y.Z` tag (bot identity via the
   version-bot secret — see version.yml's header for the tag-loop caveats),
   which fires `release.yml`: server tarballs per platform + a GitHub release
   whose body is the mechanical changelog (`scripts/release-notes.ts`).
4. Verify: the release exists, assets attached, tag matches
   `packages/server/package.json` version.
5. **Theme the notes**: run the `/release` skill (rewrites the mechanical body
   into the approved themed/emoji format via `gh release edit`).

## Phase 2 — post-cut forge migration/verify

- If forge is still an rsync tree: migrate it to a managed clone **after** the
  cut (the release-first rule: `install-source.sh` pins the newest existing
  tag; migrating pre-cut pins the previous version — a silent downgrade).
  Steps + gotchas: memory file `project_forge_migration_runbook.md`
  (short form: clone FRESH via `bash scripts/install-source.sh`, never adopt
  the rsync tree — it shipped without `.git`; config/token untouched in
  `~/.autonomos`).
- If forge is already a managed clone: `autonomos upgrade` on forge and let
  the health gate + unit sync (ADR-080) do their job; `autonomos rollback` is
  the undo.
- Verify `/api/system/version` shows the new version and, once the ~daily
  check runs, `updateAvailable: false`.

## Phase 3 — close the cycle

1. Terry restarts his local `:3100` at his convenience (his machine, his verb).
2. Update memory (`project_release_rollout_initiative.md` or successor) with
   the cycle outcome; park the release-engineer session (killed, resumable).

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
