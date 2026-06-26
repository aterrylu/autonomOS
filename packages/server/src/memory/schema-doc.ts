/**
 * SCHEMA.md content — auto-written to ~/.autonomos/memory/SCHEMA.md on first
 * init. Updated when MEMORY_SCHEMA_VERSION bumps. Keep this string the
 * canonical reference for the data model and read path; the implementation
 * (events.ts, store.ts, mcp/tools.ts) must stay consistent with it.
 *
 * Why a constant instead of a checked-in markdown file: SCHEMA.md is a
 * runtime artifact under ~/.autonomos/memory/, alongside the data it
 * describes. Authoring it as a TS constant keeps it co-located with the
 * implementation and ensures schema-version bumps update it atomically.
 */

import { MEMORY_SCHEMA_VERSION, MEMORY_SUMMARY_MAX } from "@autonomos/core";

export const SCHEMA_DOC = `# autonomOS Memory — Schema & Read Path

_Schema version: ${MEMORY_SCHEMA_VERSION}. Auto-written by autonomOS server. Do not hand-edit — changes will be overwritten on next server start. The canonical source is \`packages/server/src/memory/schema-doc.ts\` in the autonomOS repo._

## Purpose

autonomOS captures **cross-agent activity** that no other substrate sees: agent-to-agent messages, agent lifecycle events, manager-set, and schedule events. Per-project state docs (project.md, handoffs/) and Dispatcher-curated entries (decisions, findings, todos) deliberately live elsewhere — see "What's NOT here" below.

## Read path (top-down with drill-down)

Four retrieval surfaces. Claude reads the cheapest layer first and drills only when needed.

| Level | File | Token budget | Purpose |
|---|---|---|---|
| **L0** | \`index.md\` | ~500 | Catalog of projects + activity counts. Always cheap. |
| **L1** | \`projects/<slug>/summary.md\` | ~500-1000 | Rolling per-project summary. Status, recent milestones, open items. |
| **L2** | \`projects/<slug>/timeline.md\` | ~2000 | Per-project chronological summarized log. |
| **L2** | \`daily/YYYY-MM-DD.md\` | ~2000 | Cross-project "what happened today" rollup. |
| **L3** | \`events/YYYY-MM/DD.jsonl\` | unlimited | Raw events with payload field for verbatim data. |

### Typical query routing

- **"What's open?"** → L0 + each named project's L1.
- **"What did I do today?"** → L2 \`daily/YYYY-MM-DD.md\` + drill any project mentioned to L1.
- **"Why did we pick X?"** → L1 → if not there, L2 → if still not, L3 with filters.
- **"Show event Y"** → L3 by id (\`memory_query({level: "L3", id: "..."})\`).

### v1 ships
- Full L0 (auto-refreshed on every event write).
- Full L3 (raw event capture from hooks, gateway, HTTP API).
- L1 + L2 directory + skeleton files provisioned on first event for each project slug.
- \`memory_query\` MCP tool with level routing (L0/L1/L2/L3).

### Deferred
- **L1 content generation** → v2 (Stop-hook → \`claude -p\` reads recent events for the project, rewrites \`summary.md\`).
- **L2 daily content generation** → v3 (uses existing \`create_schedule\` for nightly cron).
- **L2 per-project timeline content generation** → v3.
- **BASE_CONTEXT auto-injection of L0** → v3 (one-line append in providers/shared.ts).
- **Dashboard "Memory" panel** → v2.

## Layout

\`\`\`
~/.autonomos/memory/
├── SCHEMA.md                    ← this file (auto-written; do not edit)
├── index.md                     ← L0
├── projects/
│   └── <slug>/
│       ├── summary.md           ← L1
│       └── timeline.md          ← L2 (per-project)
├── daily/
│   └── YYYY-MM-DD.md            ← L2 (cross-project; v3)
└── events/
    └── YYYY-MM/
        └── DD.jsonl             ← L3
\`\`\`

## Event schema (L3)

One JSON object per line. Field reference:

\`\`\`jsonc
{
  "v": ${MEMORY_SCHEMA_VERSION},                              // schema version
  "id": "0196A1B2C3D4-AABBCCDDEEFF",  // sortable: <12-hex ts ms>-<12-hex random>
  "ts": 1762657200123,                // epoch ms (mirrors id timestamp)
  "project": "autonomos-memory",      // slug or null (untagged is fine)
  "actor": {
    "agentId": "abc-...",             // Agent.id from ~/.autonomos/agents/<id>.json, or null
    "agentName": "Dispatcher",        // display name at log time (frozen)
    "sessionId": "claude-sess-..."    // provider session id, or null
  },
  "type": "agent_message",            // see "Event types" below
  "summary": "Sent design proposal …", // ≤${MEMORY_SUMMARY_MAX} chars (truncated with "…" if longer)
  "payload": { },                     // type-specific structured data (optional)
  "refs": {                           // cross-references for chains/queries (all optional)
    "agentIds": ["abc-..."],
    "prs": ["dyna-robotics/dyna#5685"],
    "files": ["packages/server/src/memory/events.ts"],
    "schedules": ["nightly-rollup"],
    "parentEventId": "0196A1B2C3D2-..."  // chain back to a prior event
  }
}
\`\`\`

### Event types (v1)

Closed enum at \`v=${MEMORY_SCHEMA_VERSION}\`. Future versions may add types; consumers should treat unknown values as opaque.

| Type | Captured by | Meaning |
|---|---|---|
| \`agent_created\` | HTTP \`POST /api/agents\` | New agent spawned. |
| \`agent_resumed\` | HTTP \`POST /api/agents/:id/attach\` | Exited agent reattached. |
| \`agent_exited\` | HTTP \`POST /api/agents/:id/kill\` and \`DELETE /api/agents/:id\` | Agent PTY ended. |
| \`agent_message\` | gateway router (\`routeMessage\`) | One agent sent a message via \`send()\`. |
| \`manager_set\` | HTTP \`POST /api/agents/:id/manager\` | Org chart edge changed. |
| \`prompt_received\` | hook relay (\`UserPromptSubmit\`) | Human prompt landed in an agent's CC session. |
| \`brief\` | hook relay (\`PreToolUse\` of \`SendUserMessage\`/\`Brief\`) | Agent's structured up-message via \`--brief\`. |
| \`notification\` | hook relay (\`Stop\`, \`Notification\`, \`PermissionRequest\`, \`SubagentStart\`) | Coarse agent-state signal. |
| \`schedule_created\` | HTTP \`POST /api/schedules\` | New cron/once schedule defined. |
| \`schedule_fired\` | scheduler (\`dispatchOrQueue\` after start) | A schedule began executing. |
| \`schedule_completed\` | scheduler (\`onRunCompleted\`) | A schedule run ended (success/failure/skipped). |

Events explicitly NOT in this set (they go elsewhere):

- \`decision\`, \`finding\`, \`todo\`, \`milestone\`, \`note\` — Dispatcher-curated state. Write these to **CC auto-memory** at \`~/.claude/projects/<encoded-cwd>/memory/\` via the standard Write tool, with the documented frontmatter (\`name\`, \`description\`, \`type\`, \`originSessionId\`).
- Routine tool events (\`PreToolUse\`/\`PostToolUse\` for \`Read\`/\`Grep\`/\`Glob\`/etc.) — filtered out at the hook relay to control volume.
- Per-project \`project.md\` / handoff narratives — claude_book covers this when installed; autonomOS does not duplicate.

## Project tagging

- Source of truth: \`Agent.project?\` (in \`~/.autonomos/agents/<id>.json\`), set at \`create_agent({project: "..."})\`.
- **Inheritance**: events with no explicit \`project\` inherit from the actor agent's \`project\` field at log time.
- **Override**: callers may pass \`project: "<slug>"\` to override (Dispatcher spans many projects).
- **Untagged is fine**: \`project: null\` events are valid and roll up under \`_untagged_\` in the L0 index. We never force-tag.
- **Slug normalization**: lowercase, hyphens, max 64 chars. Anything not matching is normalized in (\`My Project!\` → \`my-project\`). An input that collapses to empty becomes null.

## Refs — \`parentEventId\` and forensic preservation

### Cause→effect chains

Set \`refs.parentEventId\` when a follow-up event was triggered by an earlier one. This makes the daily-report narrative quality possible: an \`agent_message\` reply pointing back at the \`prompt_received\` that elicited it; an \`agent_created\` pointing back at the \`agent_message\` requesting the spawn.

### Forensic preservation pattern

When an agent investigation produces evidence that's archived for later inspection (e.g., a quarantined model engine, a heap dump, a captured log), record the storage URI in \`refs.files\`. The field accepts both **local paths** and **remote URIs** (\`gs://\`, \`s3://\`, etc).

**Worked example — TRT-engine corruption investigation, 2026-05-09**

The \`verify-trt-engine-corruption-hypothesis\` agent quarantined two broken engines under a dated GCS prefix. A corresponding memory event would record both URIs:

\`\`\`jsonc
{
  "v": ${MEMORY_SCHEMA_VERSION},
  "id": "0196B0F4D000-...",
  "ts": 1778354000000,
  "project": "trt-engine-corruption",
  "actor": { "agentId": "...", "agentName": "verify-trt-engine-corruption-hypothesis", "sessionId": "..." },
  "type": "brief",
  "summary": "Quarantined 2 broken TRT engines (118679 DOMA step950, 118708 FBak step5000)",
  "refs": {
    "files": [
      "gs://dyna_model_data/_quarantine/2026-05-09/dynamism-118679-DOMA-step950-broken.plan",
      "gs://dyna_model_data/_quarantine/2026-05-09/dynamism-118708-FBak-step5000-broken.plan",
      "gs://dyna_model_data/_quarantine/2026-05-09/dynamism-118679-DOMA-step950-broken.meta.json",
      "gs://dyna_model_data/_quarantine/2026-05-09/dynamism-118708-FBak-step5000-broken.meta.json"
    ],
    "prs": []
  }
}
\`\`\`

This gives cross-investigation continuity for free: a later \`memory_query({level: "L3", project: "trt-engine-corruption"})\` surfaces the URIs without anyone having to grep transcripts.

## Read API — \`memory_query\` (MCP tool)

\`\`\`ts
memory_query({
  level?: "L0" | "L1" | "L2" | "L3",   // default L0
  project?: string,                     // required for L1; filters L3
  date?: string,                        // L2 only — "YYYY-MM-DD"
  id?: string,                          // L3 only — fetch one event
  since?: number, until?: number,       // L3 only — epoch ms range
  type?: MemoryEventType[],             // L3 only
  actor?: string,                       // L3 only — case-insensitive
  limit?: number                        // L3 only — default 100, hard cap 1000
})
\`\`\`

Response is discriminated on \`level\`:
- L0/L1/L2 → \`{ level, content: string, sourcePath: string }\` (markdown body of the file; empty if not provisioned yet)
- L3 multi-fetch → \`{ level: "L3", events: MemoryEvent[] }\`
- L3 single-fetch by id → \`{ level: "L3", event: MemoryEvent | null }\`

Validation:
- L1 without \`project\` → 400.
- L2 without \`project\` AND without \`date\` → 400.
- L3 returns events newest-first; \`limit\` is clamped to [1, 1000].

## What's NOT here (intentional)

- **Per-project narratives** — see CC auto-memory + claude_book \`project.md\`.
- **Per-session conversation transcripts** — see \`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl\`.
- **Per-session task lists** — see \`~/.claude/tasks/<sessionId>/<n>.json\`.
- **User-prompt history** — see \`~/.claude/history.jsonl\`.
- **Dispatcher-curated stable facts (preferences, references)** — see CC auto-memory at \`~/.claude/projects/<encoded-cwd>/memory/\` with frontmatter (\`name\`, \`description\`, \`type\`).

## Implementation pointers (for future contributors)

- Type definitions: \`packages/core/src/types/memory.ts\`
- Append + query: \`packages/server/src/memory/events.ts\`
- Paths + slug + id: \`packages/server/src/memory/store.ts\`
- This document: \`packages/server/src/memory/schema-doc.ts\`
- MCP tool defs: \`packages/server/src/mcp/tools.ts\` (\`TOOL_MEMORY_QUERY\`)
- HTTP REST endpoint: \`packages/server/src/routes/memory.ts\`
- Capture points: \`packages/server/src/routes/hooks.ts\`, \`gateway/router.ts\`, \`routes/agents.ts\`, \`routes/schedules.ts\`, \`scheduler.ts\`

When bumping \`MEMORY_SCHEMA_VERSION\`, update this file and document the migration in \`docs/DECISIONS.md\`.
`;
