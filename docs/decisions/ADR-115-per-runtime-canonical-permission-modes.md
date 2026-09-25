## ADR-115: Per-runtime canonical permission modes

- **Date:** 2026-09-25
- **Decided by:** Terry (human). His picks were relayed by TeamLead@autonomOS. The proposal, mockup and implementation are by CodexGemini@autonomOS.
- **Context:** one shared permission list was translated for every CLI, lossily in the middle.
  - One shared list (Ask / Accept edits / Plan / Bypass) was translated for every CLI, and the translation was lossy in the middle.
  - **Claude Code:** "Accept edits" became `acceptEdits`, but Claude Code (2.1.282) also has a real `auto` (a classifier) and `dontAsk`, and it renamed `default` to `manual`.
  - **Codex (0.154):** "Ask" and "Plan" both meant `on-request` with the sandbox off. Codex has no always-ask policy: `untrusted` was removed, and `on-failure` still loads but is silently coerced to `on-request`. It does have `approvals_reviewer=auto_review` and a Plan collaboration mode, which weren't exposed.
  - **Gemini (0.46):** the modes map 1:1, except that an untrusted folder forced every mode to `default` (#407).
  - Terry: "every CLI agent has a different mode that doesn't fit a universal bucket."
- **Decision:** Terry's picks (2026-09-25):
  1. **Canonical labels.** Every user-facing permission label is the value the CLI itself accepts and reports:
     - Claude Code: `manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions`
     - Codex: `approval_policy` × `sandbox_mode` × `approvals_reviewer`, plus the collaboration mode
     - Gemini: `default`, `auto_edit`, `plan`, `yolo`

     No invented names: no "supervised"/"full" and no "Ask"/"Bypass".
  2. **A per-runtime default, stored server-side**, so agent-initiated spawns use it too. It replaces the browser-only localStorage default.
  3. **Claude Code's `manual` was to be passed explicitly,** once a clean TUI startup with the flag had been measured (an explicit `default` once broke the startup auto-Enter). **Measured: it stays flagless.** In an interleaved A/B with 18 real spawns per arm, the flag left the agent's processes writing past teardown in 3 runs (0 without it) and slowed the median prompt receipt from 691ms to 1150ms. The cost of no flag is that a `defaultMode` in the user's Claude Code settings.json applies instead. That's stated as the value's caveat wherever `manual` is offered.
  4. **Every native option is offered,** with the CLI's own caveat shown: Claude `auto` can fall back to manual; `dontAsk` denies instead of asking; Codex auto review and the Plan collaboration mode are EXPERIMENTAL in Codex. **Exception, found while implementing: Codex's Plan collaboration mode can't be set at launch.** In Codex 0.154, `thread/settings/update` is only a server notification. The mode travels with each `turn/start`, and the `--remote` TUI starts its own turns. So the API refuses `collaboration_mode=plan` with that explanation rather than recording a mode the agent never runs (TeamLead: honest over nominal). The table keeps the value, marked `perTurn`, and the dashboard points to Shift+Tab inside Codex.
  5. **No mode label on sidebar rows.** The canonical value is shown in the spawn dialog and in the Org Chart inspector's Details → Permissions row only.
  6. **Templates** store a per-runtime map of canonical values.
  7. **MCP `create_agent`:** an agent either omits `permission`, so the operator's default for that runtime applies, or passes the runtime's own canonical value, with `provider` required.
     - There is no runtime-agnostic shorthand.
     - The tool description gives one canonical example per runtime.
     - A validation error lists the valid values for the given provider.
     - The legacy `permissionMode: ask|auto|plan|bypass` is accepted and mapped to exactly what it ran before, and not recommended: it stays declared in both MCP schemas, described as DEPRECATED (the ADR-058 pattern), because an undeclared field is silently stripped by zod on the HTTP MCP path.
  8. **Migration:** every existing agent and template keeps its exact effective behavior, mapped to the native value it already ran.
     - Codex `auto`/`plan` records become `on-request` + `danger-full-access`, which is what they always ran, and they get a one-time notice.
     - Claude `ask` becomes `manual`, still with no flag until (3) is measured.
  9. **Drift guard** (the first PR). `RUNTIME_PERMISSIONS` in core is the single table of canonical values. It records the CLI's own descriptions, where they came from, the caveats, and the values deliberately not offered, with reasons. `server/runtimeProbe.ts` checks the table against each installed CLI **without starting a session**:
     - **Claude Code and Gemini:** an invalid value's parse error lists the allowed choices. The value goes before any early-exit flag, because `--version` short-circuits validation in all three CLIs.
     - **Codex settings:** `features list -c key=__probe__` lists the variants, then each value is loaded for real under a throwaway `CODEX_HOME`. This is what separates `untrusted` (rejected) from `on-failure` (loads, then coerced).
     - **Codex collaboration mode:** the offline `app-server generate-json-schema`.

     Results are cached per binary and mtime, warned about once, and served on `GET /api/providers`, together with the real CLI versions (previously always null).
  10. **Resolution order for a spawn:** explicit request (canonical `permission`, else legacy mode mapped) > the agent's record (on a resume) > the template (its per-runtime `permissions`, else its legacy mode) > the operator's per-runtime default (`runtimeDefaults` in settings) > the built-in default. Built-in templates are no longer seeded with `ask`, so they follow the operator's default. Codex's resume lock and record correction compare approval_policy, sandbox_mode and approvals_reviewer by value.
  11. **Kept from earlier ADRs.** ADR-061's resolution rules stay: resolve once after the agent record; a body-less resume changes nothing; callers forward `undefined`. So does ADR-104's Codex resume lock.
- **Rationale:** Only the CLI knows what its modes mean, and every name we invent is a lossy middle mapping that someone has to decode. Checking the table against the installed CLI turns silent vocabulary changes into a visible verdict before any spawn relies on them. Every one of these CLIs had such a change this year.
- **Alternatives considered:** four options, all rejected:
  - **Keep the shared enum (ADR-045's "A2"):** rejected. It's lossy by construction.
  - **The shared enum plus per-provider overrides ("A3"):** users would still have to learn our names.
  - **Universal "supervised"/"full" shorthands for agents:** rejected. "Full" is exact on all three CLIs, but "supervised" isn't, since Codex has no always-ask mode. Terry ruled out invented labels.
  - **A version pin only:** it can't catch a value that still parses but has changed meaning. The per-value config load catches Codex's silent coercion, which a pin would miss.
- **Supersedes:** the shared-vocabulary part of ADR-045 ("A2") and ADR-061's `ask|auto|plan|bypass` spelling. ADR-061's resolution rules are kept.
- **Source:** Claude Code session (CodexGemini@autonomOS). Terry's picks were relayed by TeamLead@autonomOS in the agent channel, 2026-09-25. Proposal and mockup: https://claude.ai/artifact/5wL5ktDhhD4zGNmSqm4Aof
