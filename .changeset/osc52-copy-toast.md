---
"@autonomos/dashboard": patch
---

Add a brief "Copied N chars" confirmation toast when Claude Code auto-copies a terminal selection via OSC 52. Auto-copy-on-select was previously silent — especially on remote (plain-HTTP) deployments where the copy goes through the `execCommand` fallback — so there was no signal that anything reached the clipboard. The toast floats over the terminal pane, auto-dismisses after ~2s, and coalesces the repeated OSC 52 emissions Claude Code sends while a selection stays live during streaming (so it doesn't flicker). If both clipboard mechanisms fail it shows "Copy failed" instead.
