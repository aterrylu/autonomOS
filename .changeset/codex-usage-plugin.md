---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Add Codex/OpenAI usage tracking to the dashboard, mirroring the Claude Code usage plugin. A new `codex-usage` status-bar item shows a Codex agent's token/rate-limit availability beside the Claude one, and hides itself entirely when there's no Codex signal (no `~/.codex` login, no rollout) so non-Codex users never see it.

Data source is two-tier and strictly READ-ONLY (ADR-048): PRIMARY is the live ChatGPT-plan usage endpoint (`GET {base}/wham/usage`, real-time — plan, primary/secondary windows, credits, per-model `additional_rate_limits`), reading the Codex OAuth token read-only from `~/.codex/auth.json`; FALLBACK is the freshest on-disk rollout `token_count.rate_limits` snapshot when the token is expired/absent or the endpoint is unreachable. The token is NEVER refreshed, rotated, or written — refreshing would rotate it and break the user's Codex CLI login. Window titles/labels are derived from each window's own length (Session/Weekly/Monthly · 5h/7d/30d) so they stay honest across free and paid plans.
