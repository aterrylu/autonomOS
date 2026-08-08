---
"@autonomos/server": minor
"@autonomos/core": patch
"@autonomos/dashboard": patch
---

Deprecate the agent `capabilities` field (ADR-058). It was meant to restrict which MCP tools an agent could see, but it was never a real boundary — a capability-restricted agent still carried `AUTONOMOS_TOKEN` in its own environment and could call the REST API directly, so the field gated the advertised tool list without restricting anything reachable. Worse, the injected system prompt advertised the full toolset regardless, so a restricted agent was told it had tools that weren't registered — indistinguishable from a broken server, which cost real debugging time.

The field is removed from the `create_agent` MCP schema and the templates API, and the tool-list filtering is gone (all agents get the full list). Existing template files carrying `capabilities` still load — the field is accepted and ignored. Restrict worker agents through their `systemPrompt` prose instead.
