---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(presets): Kimi and other provider presets work again; operators can allow extra keys

The env-preset allowlist from the previous release missed keys that real provider setups use. Kimi's official Claude Code setup, for example, sets `ANTHROPIC_DEFAULT_FABLE_MODEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_EFFORT_LEVEL`, so those presets were refused.

- The allowlist now covers every variable the official Claude Code guides of Kimi/Moonshot, Z.ai GLM, DeepSeek, OpenRouter, LiteLLM, Alibaba DashScope, MiniMax, Vercel AI Gateway, Requesty and Cloudflare tell you to set, plus Claude Code's own model, endpoint, Bedrock, Vertex and Foundry settings, and the Codex and Gemini equivalents. Variables that make a CLI run commands or load its config from elsewhere stay blocked.
- If your provider needs a key autonomOS doesn't know yet, allow it yourself in Settings → Env presets → "Extra allowed keys". Agents can't change this setting.
- A preset that still sets a key that isn't allowed no longer starts an agent with that key quietly missing (which could run a different model). The agent isn't started, and the message names the key and how to allow it or remove it.
