# Addendum: how autonomOS memory relates to Claude Code's native memory (2026-09-12)

Terry's reaction to the [README](README.md): the Phase 0 "bridge" is out, because it assumes Claude Code is installed and used. He wants autonomOS memory to be **first-class and provider-universal**, with an explicit, chosen relationship to Claude Code's auto-memory: co-exist with it, or compete with it and have everyone use ours. Locked so far: both scopes (fleet-shared + per-agent), storage in `$configDir/memory/`, direct attributed writes, verbatim facts, FTS-only v1.

This addendum works the option space, verifies the two facts option A depends on, and recommends.

## What was verified before writing this

1. **An inline `--settings` `autoMemoryDirectory` redirects a spawned session, read and write.** Test: a fresh git cwd in the scratchpad, a pre-seeded directory containing `MEMORY.md` + one fact file with a planted codeword, then
   ```
   claude -p "What codeword is in your memory index? … append 'redirect-test: seen' to your MEMORY.md" \
     --settings '{"autoMemoryDirectory":"<scratch>/memtest/mem"}' --model haiku
   ```
   It answered `PELICAN-42` and appended the line to *that* `MEMORY.md`. The default `~/.claude/projects/<slug>/` dir was created for the transcript, but **no `memory/` subdir appeared there**. autonomOS already builds this exact `--settings` object at `providers/claude-code.ts:236`, so the redirect is one added key per spawn.
2. **The real on-disk fact format is not quite what the docs describe.** Claude Code rewrote my hand-written frontmatter into its canonical block form:
   ```yaml
   ---
   name: project_agent_memory_research
   description: "…"
   metadata:
     node_type: memory
     type: project
     originSessionId: 4722edbd-…
     modified: 2026-09-12T03:13:32.694Z
   ---
   ```
   Across Terry's 134 files: 120 carry `metadata.type`, 21 carry a top-level `type:`, 78 have `modified`, 116 have `node_type`. Any parser of ours must accept both shapes and treat `metadata.*` as canonical. The `MEMORY.md` index is one markdown link line per fact, capped at **200 lines / 25 KB** on load (Claude Code errors on a write that exceeds it). Terry's index is at 129 lines / 19 KB — within two months of the cap.

## The keying mismatch that shapes everything

Claude Code keys memory by **git repository**. Our fleet is not one repository: `list_agents()` shows agents scoped `@autonomOS`, `@homelab`, `@workflow`, `@Agents+DL`, `@terrylu-cloud`, `@laptop`, each with its own cwd, and the agent record already carries a `project` field. So "fleet-shared" cannot mean one bucket: a homelab agent must not inherit "never bind :3100" as a rule, and an autonomOS agent must not see camera runbooks. The two-scope model in the README needs a third level:

```
$configDir/memory/
├── fleet/                     # truly global: who Terry is, house rules that hold everywhere
├── projects/<project>/        # ≈ Claude Code's per-repo memory, provider-neutral
└── agents/<agentName>/        # identity-keyed role state
```

This is the mapping that makes option A clean: **Claude Code's "per repo" is our "per project."**

## Options

### A. Redirect Claude Code's native memory into our store

Every Claude Code spawn gets `autoMemoryDirectory: $configDir/memory/projects/<project>/` in its `--settings`. Claude Code keeps its native behaviour (auto-recall of the index at start, auto-save of `user/feedback/project/reference` facts, `/memory`) but the **store is ours**. Codex and Gemini agents reach the same files through our `recall`/`remember` tools and the spawn-time digest. Claude Code becomes one client of the store, not the owner of it.

Sub-choices:
- **A1 — native writer → `projects/<project>/`** (recommended). Preserves exactly today's proven behaviour (all Claude Code agents in a project share one index) and the existing corpus maps 1:1. Per-agent state goes through `remember(scope: "agent")`; the fleet and agent indexes reach Claude Code through our digest, not through its native loader.
- **A2 — native writer → `agents/<name>/`.** Gives each Claude Code agent private automatic capture, but the shared project knowledge then depends entirely on our digest (capped like the index), and 134 files of shared knowledge would have to be re-homed by hand. Loses more than it gains.

What A must handle:
- **Format:** our schema is a superset by construction (`name`, `description`, `metadata.{type, originSessionId, modified}` + our `scope`, `author`). Our indexer reads Claude Code's files unchanged; our writer emits the same block form so Claude Code keeps recognising them. **No conversion step.**
- **Index cap:** Claude Code stops loading `MEMORY.md` at 200 lines / 25 KB and refuses writes past it. Under A the project index is shared by every provider, so it will hit the cap sooner. Our reindex must **curate the index** (fold old lines into topic files, keep one line per fact) or Claude Code's native writer starts failing. This is the one genuine engineering cost A adds.
- **Concurrency:** unchanged from today (multiple Claude Code sessions already rewrite the same index; drift is observed). Our writer adds atomic temp+rename per file and rebuilds the index from files, which also repairs Claude Code's drift.
- **Sessions not spawned by autonomOS** (Terry's own terminal in the repo): they keep Claude Code's default per-repo dir. Two levers, Terry's choice: (i) accept the divergence — Terry's personal sessions have personal memory, the fleet has fleet memory; or (ii) set `autoMemoryDirectory: ~/.autonomos/memory/projects/autonomOS` in the repo's `.claude/settings.local.json` so terminal sessions join the store too. External sessions **adopted** into autonomOS (ADR-056) are respawned with our `--settings`, so they re-point on adoption; Claude Code reads the memory dir at session start, so a resumed session picks up the new location.
- **A machine with no Claude Code:** the store, the tools, the digest and the dashboard are complete; only *automatic* capture is absent (Codex/Gemini agents `remember` deliberately, and Phase 2 adds compaction/session-end nudges). Nothing in A depends on Claude Code being present; A only adds Claude Code's writer as an extra client when it is.
- **The 134 files:** a one-time `cp` into `projects/autonomOS/` (no transform), then re-point spawns. Keep the old dir as a backup until the next release cut; Terry's terminal sessions keep writing there unless lever (ii) is taken.

### B. Full coexistence: two stores with sync

Ours in `$configDir/memory/`, Claude Code's in `~/.claude/projects/<slug>/memory/`, with an import (and possibly export) job between them.

Costs, honestly: two sources of truth; a sync loop that has to reconcile edits on both sides (Claude Code rewrites `MEMORY.md` wholesale, so line-level merge is guesswork); conflict semantics nobody will remember; every "which copy is right?" question lands on Terry. It generalises the rejected bridge and inherits its assumption that Claude Code's dir is a peer store worth keeping alive. One-directional import (their dir → ours, on a timer) is the least-bad form and is exactly the "seed" step A already contains, minus the ongoing drift.

### C. Ours standalone; Claude Code's native memory left alone (or disabled)

Claude Code agents use `recall`/`remember` like everyone else. Their native auto-memory either keeps running in its default dir (a parallel, invisible store: the divergence Terry is objecting to) or is switched off per spawn with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` / `autoMemoryEnabled: false`.

Cleanest single-system *story*, but it forfeits the best capture mechanism available: Claude Code's writer is the reason 134 well-formed facts exist at all, nobody had to ask for them. Under C every memory is deliberate, on every provider, from day one. Disabling native memory also removes `/memory` and the "Saved N memories" affordances Terry sees in his own sessions.

## Comparison

| | A. Redirect into ours | B. Two stores + sync | C. Ours standalone |
|---|---|---|---|
| Single source of truth | **Yes** | No | Yes (if native disabled), else no |
| Claude Code automatic capture kept | **Yes** | Yes (in their store) | No |
| Provider-universal read/write | **Yes** (tools + digest) | Yes for ours; theirs is CC-only | Yes |
| Complete without Claude Code | **Yes** | Yes | Yes |
| Format work | Parser accepts both frontmatter shapes; writer emits CC's block form | Converter both ways | Our own format, free choice |
| Ongoing cost | Index-cap curation on reindex | Sync + conflict handling forever | Agents must `remember` deliberately |
| Existing 134 files | `cp` once, done | Seed + keep syncing | Import once; native dir keeps growing separately unless disabled |
| Terry's terminal sessions | Diverge, or one `settings.local.json` line joins them | Diverge (synced later) | Diverge |
| Reversibility | Remove one settings key → CC falls back to its default dir | Turn off sync | Re-enable native memory |
| Build size (over the README's Phase 1) | +S (settings key, index curation) | +M (sync engine) | +0 |

## Recommendation

**A1.** It dissolves the co-exist/compete question rather than answering it: there is one store, ours, provider-neutral and complete on a box with no Claude Code; when Claude Code *is* present, its native memory machinery becomes one more writer into `projects/<project>/`, verified to work with a single `--settings` key we already emit. The format is compatible without conversion (our writer must emit Claude Code's `metadata:` block form; our reader must accept both shapes). The only real added cost is index-cap curation, which we want anyway because the shared index is the digest every provider gets.

Consequences for Phase 1 scope:
1. Scopes become `fleet/`, `projects/<project>/`, `agents/<name>/`; `remember` takes `scope` with `project` as the default for Claude Code-style facts. Project resolves from the agent record's `project`, falling back to the repo name of the cwd (which keeps the mapping identical to Claude Code's for unscoped agents).
2. Claude Code spawns get `autoMemoryDirectory` = the project dir. The record does not need a new field: the path is derived, like the digest.
3. Reindex curates `MEMORY.md` to stay under Claude Code's cap and repairs orphans; markdown remains the truth, the SQLite index stays disposable.
4. One-time `cp` of the 134 files into `projects/autonomOS/`. Terry decides lever (ii) for his terminal sessions; recommended yes, one line in `.claude/settings.local.json`.
5. The ADR records: "Claude Code's native memory is a client of the autonomOS store, not a peer store," and the reversibility (drop the key).

**Questions this leaves for Terry**
1. A1 (native writer → project scope) or A2 (→ agent scope)?
2. Join his own terminal sessions to the store via `.claude/settings.local.json`, or keep them separate?
3. Copy the 134 files into `projects/autonomOS/` at Phase 1 merge, or leave them where they are and start fresh?
