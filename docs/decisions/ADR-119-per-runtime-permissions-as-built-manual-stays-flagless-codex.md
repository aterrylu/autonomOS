## ADR-119: Per-runtime permissions as built: manual stays flagless, Codex Plan is per-turn, spawn order

- **Date:** 2026-09-26
- **Decided by:** TeamLead@autonomOS, relaying and applying Terry's ADR-115 picks, approved each outcome below. CodexGemini@autonomOS measured the facts and implemented them.
- **Context:** Building ADR-115's second phase (agents spawn from their CLI's own values) produced two measured facts that contradict two of its picks, and three implementation choices worth recording. ADR-115 had already merged, so they go here rather than into its text.
- **Decision:** five outcomes, as built.
  1. **Claude Code's `manual` is spawned WITHOUT a flag** (ADR-115 pick 3 said to pass `--permission-mode manual` once a clean startup was measured). Measured, interleaved A/B with 18 real spawns per arm:
     - With the flag, 3 spawns left the agent's processes writing past teardown (ENOTEMPTY on the fake HOME); without it, 0.
     - The flag also slowed the median prompt receipt from 691ms to 1150ms.

     The cost of no flag is that a `defaultMode` in the user's Claude Code settings.json applies instead. That's the `manual` value's caveat in `RUNTIME_PERMISSIONS`, shown wherever it's offered.
  2. **Codex's Plan collaboration mode is refused at launch** (ADR-115 pick 4 said to offer every native option).
     - In codex 0.154, `thread/settings/update` is only a server notification. The mode travels with each `turn/start`, and the `--remote` TUI starts its own turns.
     - So `collaboration_mode=plan` is rejected with that explanation rather than recorded as a mode the agent never runs (honest over nominal).
     - The table keeps the value, marked `perTurn`. The dashboard points at Shift+Tab inside Codex.
  3. **The legacy `permissionMode` stays DECLARED in both MCP schemas as DEPRECATED** (the ADR-058 pattern), rather than being removed. An undeclared field is silently stripped by zod on the HTTP MCP path. It's accepted and mapped to exactly what it always ran.
  4. **Spawn resolution order:**
     1. explicit request (canonical `permission`, else the legacy mode mapped)
     2. the agent's record (on a resume)
     3. the template (its per-runtime `permissions`, else its legacy mode)
     4. the operator's per-runtime default (`runtimeDefaults`)
     5. the built-in default

     Built-in templates are no longer seeded with `ask`. Codex's resume lock and record correction compare approval_policy, sandbox_mode and approvals_reviewer by value.
  5. **Kept:** ADR-061's resolution rules (resolve once after the agent record; a body-less resume changes nothing; callers forward `undefined`) and ADR-104's Codex resume lock.
- **Rationale:** a record must never claim a setting the process isn't running. Both reversals come from measuring the installed CLIs rather than assuming. Passing a flag that measurably harms teardown, or accepting a mode that can't be applied, would trade a real behavior for a nominal one.
- **Alternatives considered:** three, all rejected.
  - **Pass `manual` anyway, accepting the teardown risk:** the A/B showed it's worse on both teardown and latency.
  - **Set Plan on every `turn/start` autonomOS sends:** it can't cover the turns the TUI starts itself, so the recorded mode would still lie.
  - **Remove `permissionMode` from the schemas:** old callers would silently lose it on the HTTP MCP path.
- **Supersedes:** ADR-115 (picks 3 and 4, in part)
- **Source:** Claude Code session, CodexGemini@autonomOS; TeamLead@autonomOS in the agent channel, 2026-09-25/26; PR #418.
