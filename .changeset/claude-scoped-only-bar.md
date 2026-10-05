---
"@autonomos/dashboard": patch
---

fix(claude-usage): a plan whose only usage window is model-scoped (e.g. Fable-only) now shows it on the status bar even at 0% — a fresh week rendered just the Claude icon, with no number and no explanation. Plans with 5h/7d windows are unchanged.
