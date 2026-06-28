---
"@autonomos/dashboard": patch
---

Clearer permission-mode dropdown labels: "Default" → **Ask**, "Auto-edit" → **Accept edits** (Plan and Bypass unchanged). "Auto-edit" was confusing — that mode auto-approves edits but still gates riskier actions, and "Accept edits" matches Claude Code's own terminology. Labels-only; the underlying enum values (`default`/`auto`/`plan`/`bypass`) and behavior are unchanged. Sourced from the single `PERMISSION_MODE_INFO` constant in core.
