---
"@autonomos/core": minor
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Model-override env presets (ADR-067): named, server-stored sets of environment variables applied to an agent at spawn to override its model backend — the motivating case is running Kimi (Moonshot) through the real Claude Code binary via its Anthropic-compatible endpoint. No new provider; the override is entirely env. Agents configure a preset (endpoint, model, declared secret key names) via MCP but cannot set the secret value — a human keys it in the new dashboard Presets tab. Secret values are masked on every read; reserved control-plane and code-injection env keys are rejected and stripped; a preset whose API key is unset refuses to spawn.
