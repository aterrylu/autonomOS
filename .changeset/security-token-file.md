---
"@autonomos/server": patch
---

Per-agent tokens are now delivered to the channel-server via a per-session `0600` file (`<configDir>/agent-tokens/<sessionId>`) instead of provider-specific env/argv, consolidating three divergent delivery paths into one. This removes the Codex per-agent token from world-readable `/proc/<pid>/cmdline` (it was a `-c` flag) and is verified end-to-end for Claude and Codex — both write the file and register on the gateway (Claude has no env-token fallback anymore, so a register proves the file path). The file is written at spawn, unlinked on exit, and swept at boot; the hook path is unchanged (still env). It also fixes the token-*delivery* precondition for Gemini, but Gemini outbound remains broken for a separate reason — Gemini never launches its MCP channel-server subprocess in `-i` mode — so `send()`/org tools for Gemini stay unavailable pending a separate follow-up. See ADR-055 (token-file follow-up).
