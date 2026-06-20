---
"@autonomos/server": minor
"@autonomos/dashboard": minor
"@autonomos/core": minor
---

Remove "view mode" and all non-xterm terminal renderers — terminal (xterm.js) is now the only view and the only renderer.

The `/api/conversation` route that parsed Claude Code session JSONL into a web "conversation" view is deleted, along with the `@autonomos/core` `ClaudeCodeParser` and render/parser types and the dashboard `ConversationView`. The Ghostty (`ghostty-web`) renderer and the renderer-selection abstraction are removed; the `terminalRenderer` settings key is accept-and-discarded (scrubbed on read with a warning naming it, dropped from disk on next save) following the established removed-feature convention. Five now-dead dependencies are dropped to slim the bundle: `ghostty-web`, `react-syntax-highlighter` (+ types), and the unused `@assistant-ui/react` / `@assistant-ui/react-streamdown`.
