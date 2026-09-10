---
"@autonomos/core": patch
---

fix(permissions): "Ask" explainer is honest that Claude Code's own default governs

Per ADR-061, the `ask` mode passes NO flag to Claude Code — it IS Claude Code's
own built-in behavior, which the user's `~/.claude/settings.json` `defaultMode`
can override. The explainer's Claude row said "Prompts on each tool use", so a
user with `defaultMode: acceptEdits` saw the form say "Ask" while the TUI
actually started in accept-edits. Display-only fix (the no-flag spawn behavior
is deliberate and unchanged): the Claude row now reads "Defers to Claude Code's
own default (no flag passed) — your ~/.claude/settings.json defaultMode may
change it". Gemini/Codex are unchanged (they receive an explicit flag, so "ask"
is enforced there).
