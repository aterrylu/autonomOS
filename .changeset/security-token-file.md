---
"@autonomos/server": patch
---

Per-agent tokens are now delivered to the channel-server via a per-session `0600` file (`<configDir>/agent-tokens/<sessionId>`) instead of provider-specific env/argv. This fixes Gemini outbound (`send()` + org tools), which was dead because Gemini strips `*TOKEN*` names from its MCP-subprocess env, and removes the Codex token from world-readable `/proc/<pid>/cmdline` — one uniform mechanism replacing three divergent code paths. The file is written at spawn (before the channel-server launches) and unlinked on exit; the hook path is unchanged (still env). See ADR-055 (token-file follow-up).
