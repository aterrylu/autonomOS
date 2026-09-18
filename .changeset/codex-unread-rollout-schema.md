---
"@autonomos/server": patch
---

fix(codex): read the current codex rollout reply shape for the unread badge

The codex unread (#num) badge never incremented because F3's rollout reader
(`codexRollout.ts`) scanned for `event_msg`/`agent_message`/`message` — a shape
codex had already dropped. Current codex (0.15x) writes the reply as a
`response_item` with `payload.type:"message"`, `role:"assistant"` and text in
`content:[{type:"output_text",text}]`, so every read returned null ("turn ended
with no readable reply yet — not counted") and no codex turn ever counted. This
had also regressed #358's content-less turn bump, which #368 replaced with the
content read.

`extractAssistantReply` (new, exported — the single source of truth for the
reply shape) now handles the current shape while keeping the legacy
`event_msg/agent_message` path for older codex and existing rollouts. Fixtures
are derived from real 0.15x rollout output (the old fixtures were green but
vacuous against reality). Empirically verified with a real codex agent: a
completed turn increments unread and shows the reply text in the bell panel.
