---
"@autonomos/server": patch
---

fix(claude-code): turn hooks run in order, so an idle agent can't be left showing "Working"

Every Claude Code hook is its own `curl`, and they were all async, so the server could receive a turn's events in any order. Status is set by whichever event arrives last, so a UserPromptSubmit that landed after its turn's Stop left an idle agent showing "Working" until its next event, which for an idle agent may be never. Busy multi-agent boots (restart-all, several spawns) made it likely; it was the intermittent `agent-spawn-prompt` failure under concurrent test runs.

SessionStart, UserPromptSubmit and Stop now run as synchronous hooks, which Claude Code finishes before moving on, so they arrive in order; every other event stays async. Measured cost of the hook itself: p50 11 ms, p99 about 100 ms at turn start and end with a healthy server; just as fast when the server is down; about 2.2 s per hook while the server is frozen, bounded by the hook's own limits so a turn never hangs. Gemini is unchanged: its CLI already waits for these hooks.
