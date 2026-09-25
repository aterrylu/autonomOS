## ADR-020: Agent Context Assembly — Explicit systemPrompt Over SDK Parent-Dir Walk
**Date:** 2026-03-17
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** The Claude Agent SDK automatically walks parent directories for CLAUDE.md files when `settingSources` includes `"project"`. This could be used to inherit `~/.autonomos/CLAUDE.md` by placing agents under `~/.autonomos/`. However, this behavior is a side effect of `settingSources`, not a documented primary feature, and breaks if agent folders move.

**Decision:** The autonomOS agent runner explicitly assembles the system prompt from files and injects via the `systemPrompt` parameter. `settingSources: ["project"]` is used only for skills and `settings.json` — not for CLAUDE.md inheritance.

```typescript
const baseContext = readFile("~/.autonomos/CLAUDE.md")
const agentContext = readFile(`agents/${name}/.claude/CLAUDE.md`)

query({
  prompt: triggerMessage,
  options: {
    systemPrompt: `${baseContext}\n\n---\n\n${agentContext}`,
    cwd: agentFolder,
    settingSources: ["project"],   // loads skills + settings.json only
  }
})
```

**Context layers an agent sees:**
1. `systemPrompt` — explicitly assembled base context + agent-specific context
2. `settingSources: ["project"]` — skills from `.claude/skills/`, permissions from `.claude/settings.json`
3. `prompt` — the trigger message (cron tick message or user message)

**Rationale:**
- Explicit assembly is debuggable — log the full system prompt before each run.
- Location-independent — agent folders can live anywhere, not just under `~/.autonomos/`.
- Not subject to SDK behavior changes. Parent-dir walking is undocumented side effect behavior.
- Composition order is controlled — base context always before agent context.

**Alternatives:**
- **Rely on SDK parent-dir walk** — simpler but fragile. Breaks on folder moves, depends on undocumented behavior, hard to debug.
- **Symlink CLAUDE.md** — fragile, platform-specific, still implicit.
