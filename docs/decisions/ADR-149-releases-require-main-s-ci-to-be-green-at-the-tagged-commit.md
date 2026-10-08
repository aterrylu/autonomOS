## ADR-149: Releases require main's CI to be green at the tagged commit

- **Date:** 2026-10-08
- **Decided by:** Proposed by SecurityAudit-Claude and built by the release engineer agent (ReleaseRollout), as release-process hardening within the release owner's remit. It follows Terry's "B: go" to drop the "up to date with main" merge requirement, relayed by TeamLead.
- **Context:** On 2026-10-08 the main ruleset stopped requiring PRs to be up to date with main (strict_required_status_checks_policy → false), to end the update-branch loops that starved merges. So a squash now lands the reviewed head *plus* whatever merged since: a combination no PR run tested. While checking that trade-off, we found `test.yml`, `e2e.yml` and `test-install.yml` ran **only on pull requests**. Nothing tested main's own commits, so a combination that broke after merge would go unnoticed, and a release could be cut from it.
- **Decision:**
  - `test.yml`, `e2e.yml` and `test-install.yml` also run on `push` to main.
  - `release.yml` gains a `main-ci` job that `release` (publish) needs. For each of the three workflows, it finds the push run on main for the tagged commit and waits for it: it must start within 15 minutes and finish within an hour. Success proceeds. Failure, no run or a timeout refuses to publish, with a message. It runs whenever publishing would (a tag push, or a dispatch with dry_run=false), the same condition as the existing `on-main` ancestry check.
  - There is no skip switch. If main is red, fix it forward or re-run a flaky job, then re-run the release.
- **Rationale:** The merge rules now trust each PR's own CI; this restores the missing check at the point where it matters to users, the release. Users install tagged releases, not arbitrary main commits, so gating the tag on main's green CI means a broken combination can't ship before the fix lands. It is cheap: the repo is public, so GitHub-hosted runner minutes are free, and the wait overlaps the release's own build. The tag is created right after the version PR merges, while that commit's runs are still going, which is why the gate waits instead of checking once.
- **Alternatives considered:**
  - A merge queue, which tests the combination *before* it lands. Unavailable on this user-owned repository (proven 2026-10-04); a move into an organization was declined.
  - Restoring "up to date with main". That brings back the merge starvation Terry's B removed.
  - Running main's CI but not gating the release on it. Detection without prevention: a release could still be cut during a red window.
  - Checking GitHub's combined commit status instead of named workflows. It's less precise, since unrelated statuses can keep it pending forever, and absence can't be told apart from success.
- **Source:** SecurityAudit-Claude's request on the agent channel (2026-10-08), after the ruleset change. Built and tested in a ReleaseRollout Claude Code session: the gate script was run against real CI history (an all-green commit passes; a commit with a failed test-install run is refused; a commit with no runs is refused).
- **Supersedes:** none. Complements ADR-126/128 (provenance, and tags on main).
