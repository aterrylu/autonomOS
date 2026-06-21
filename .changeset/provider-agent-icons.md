---
"@autonomos/dashboard": minor
"@autonomos/server": minor
---

Agent rows can now show a per-provider icon. A new "Agent Icons" setting (with a visual two-card picker in the settings panel) switches between **Provider + status** — the provider's official mark (Claude / Codex / Gemini) with a small status badge in the corner — and the original **Status only** icon. Defaults to Provider + status. The org-chart tree API now carries each agent's `provider` so cards there match the sidebar. Also fixes the "working" status spinner, which previously rendered as a single chasing petal instead of a full rotating spinner.
