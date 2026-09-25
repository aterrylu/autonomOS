## ADR-027: Provider-aware hook event translation; Codex status-blind for now
**Date:** 2026-04-23
**Decided by:** Terry + MultiProviderFix agent
**Source:** Claude Code session (post-PR #133 bug fix)

**Context:** PR #133 shipped `AgentProvider` with Codex + Gemini backends, but neither produced working end-to-end agents in the dashboard. Two distinct failures:
- **Gemini** — hooks fire correctly (the settings file at `~/.autonomos/gemini-settings.json` is written and loaded), but Gemini emits native event names (`BeforeTool`, `AfterAgent`, `PreCompress`, etc.) that fall through the CC-shaped switch in `deriveStatus()`. Status stays frozen.
- **Codex** — the `--enable codex_hooks` flag toggles a feature that is `under development` per `codex features list`. No hooks config format exists in Codex today (`~/.codex/hooks.json` is not a real file), and autonomOS never wrote one anyway. The flag is a no-op.

**Decision:**
1. Add an optional `normalizeEvent(raw) → raw | null` method to `AgentProvider`. The hook route looks up the session's provider and translates the event before calling `deriveStatus`. CC has no translator (identity). Gemini provides a name+field translator (e.g. `BeforeTool → PreToolUse`, `AfterAgent → Stop`, Gemini's `ToolPermission → permission_prompt`).
2. Drop the dead `--enable codex_hooks` flag. Mark Codex capabilities honestly (`hooks: { eventCount: 0, perSession: false, requiresSetup: false }`). Codex agents spawn, respond, and can call MCP tools, but do not drive dashboard status — they show "running" until they exit. Accept this until Codex ships stable hooks OR we integrate with `codex app-server --listen ws://` (WebSocket JSON-RPC).

**Rationale:** The minimum fix. The translator approach keeps `deriveStatus()` untouched (no state-machine refactor), adds one optional method per provider, and scales linearly as providers are added. The canonical-event-bus refactor (decouple transport from semantics; define provider-neutral event vocabulary) was considered but rejected as premature abstraction: three providers, only one of which needs translation, and one of which can't emit events at all no matter what shape we define. Revisit if the provider set grows to 4+.

**Alternatives:**
- **Canonical event vocabulary owned by autonomOS** (`session.start`, `turn.start`, `tool.start`, …) with per-provider adapters mapping native → canonical. Cleanest long-term architecture, but ~5x the code for the same user-visible outcome today.
- **Per-provider `deriveStatus()` strategies.** More flexibility per provider, but duplicates state-machine logic and risks status vocabulary drift across providers.
- **Codex `app-server` WebSocket integration.** The correct long-term path for Codex status — OpenAI ships TS bindings and JSON schema generators for the protocol. Deferred to a later plan; current work is not in that direction.
- **PTY output scraping for Codex.** Tail `~/.codex/log/codex-tui.log` or scrape terminal output. Fragile, coupled to internal format.

**Lesson during QA — semantic mismatch on `PreCompress`:**
Initial mapping included `PreCompress → PreCompact`, justified by upstream docs ("PreCompress fires before history summarization"). Live QA showed every Gemini turn flashing the dashboard into "compacting" status, even when no compression was happening. Reading `gemini-cli-core/services/chatCompressionService.ts` revealed that `PreCompress` fires *unconditionally* at the start of every turn as a "we're entering the compression decision tree" hook — the threshold check that decides whether to actually compress runs *after* the hook. That's structurally different from CC's `PreCompact`, which only fires when compaction is actively starting. There's also no `PostCompress` counterpart in Gemini, so we couldn't model the start/end pair anyway. Fix: drop `PreCompress` from `GEMINI_TO_CC_EVENT` and add to `INTENTIONAL_DROPS`. Generalization: for translator-based provider abstractions, **vendor docs give you event *names*; only vendor *source* gives you event *firing semantics*** — verify both before mapping.
