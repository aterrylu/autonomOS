---
"@autonomos/server": patch
---

fix(security): env presets can set only model-backend variables

An env preset exists to point an agent at another model backend (for example Kimi through Claude Code). It could also set any other environment variable, including ones that make an agent's shell or tools run arbitrary commands (`BASH_ENV`, `SHELL`, `GIT_SSH_COMMAND` and similar), which the old blocklist missed.

- A preset can now set only model, endpoint and auth variables (`ANTHROPIC_*` backend keys, `OPENAI_API_KEY`/`OPENAI_BASE_URL`, Gemini/Google backend keys), plus proxy and CA-certificate settings. Saving any other key is refused, with the list of allowed keys.
- A preset you saved earlier still works. Any key it sets that's no longer allowed is skipped when an agent starts, and you get a notice naming it so you can remove it in the Presets tab.
