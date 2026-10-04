## ADR-147: The decisions index is regenerated hourly, not after every merge

- **Date:** 2026-10-04
- **Decided by:** Terry. He approved batching the index bot as part of the merge-throughput fix, relayed by TeamLead. Built by the release engineer agent (ReleaseRollout).
- **Context:** ADR-114 made `docs/decisions/README.md` a generated index, rebuilt by the decisions-index workflow on every push to main and delivered as one rolling bot PR. Main now lands a commit every 5–15 minutes, and full CI takes about 25. The ruleset requires a PR to be up to date with main before merging. So every feature merge was followed by a second, bot merge. That doubled the traffic on main, and approved, green PRs kept falling behind mid-CI (one release PR needed three update rounds).
- **Decision:** The workflow runs on an hourly schedule (`cron: "17 * * * *"`) plus manual dispatch, not on every push. Each run still regenerates from main. It opens or updates the one rolling bot PR only when main's index is stale, and closes a redundant one otherwise. Nothing else about ADR-114 changes: PRs never edit the index, the bot PR goes through the same gate (required checks, one approval, auto-merge), and it is opened with `RELEASE_PAT`.
- **Rationale:** The index is informational. Nothing reads it at build or run time, so an index up to an hour stale costs nothing, while a bot merge after every feature merge costs every open PR a CI round. One hourly PR carries every ADR merged in that hour. A schedule also removes the self-trigger loop outright: the bot's own merge can't start a scheduled run.
- **Alternatives considered:**
  - Keep per-push runs but debounce them (e.g. a concurrency group with a delay). GitHub Actions has no native debounce, and a sleep-then-check job burns runner minutes and still merges once per burst.
  - Regenerate the index in the PR that adds the ADR. Rejected by ADR-114 itself: it recreates the shared-file conflict hotspot.
  - Drop the generated index. Rejected: it is the human entry point to the decisions.
  - Daily instead of hourly. Too slow for a contributor looking up an ADR merged that morning.
- **Source:** TeamLead's relay of Terry's go on the merge-throughput fixes (2026-10-04), in a ReleaseRollout Claude Code session. GitHub's merge queue, the first choice, turned out to be unavailable on this user-owned repository. That is a separate decision for Terry.
- **Supersedes:** none. It amends ADR-114's regeneration trigger only.
