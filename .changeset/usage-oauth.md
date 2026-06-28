---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Claude Usage now reads Claude Code's local OAuth token (read-only) as the
zero-touch default credential, calling Anthropic's OAuth usage endpoint for the
full per-window, per-model, and extra-credits breakdown. The token is never
refreshed and never written to disk. Pasting a claude.ai session key still works
as an explicit override. The old cookie-scanning / agent-harvest machinery
(which couldn't obtain a cookie on a clean OAuth-only install) is removed, and
the `autoDetectClaudeSession` setting is renamed `autoDetectClaudeAccount`
(the old key is still read for back-compat).
