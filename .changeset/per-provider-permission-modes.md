---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Replace the coarse `autonomousMode` boolean with a per-provider **permission mode** (`default` | `auto` | `plan` | `bypass`). The single on/off switch couldn't express the granularity each CLI actually supports, so spawning an agent was all-or-nothing on permission prompts.

Each provider now maps the common mode to its native surface: Claude Code → `--permission-mode default|acceptEdits|plan` (or `--dangerously-skip-permissions` for bypass), Gemini CLI → `--approval-mode default|auto_edit|plan|yolo`, and Codex → `approval_policy=on-request|on-failure|never` (its sandbox stays `danger-full-access` — autonomOS is the trust boundary). Codex has no plan mode, so `plan` is disabled for it in the UI and clamps to the default with a warning.

The Settings panel sets a global default and the Create Agent panel can override it per spawn; both expose a clickable "?" explainer describing what the selected mode does for each provider. Templates carry their own default permission mode.

Migration is transparent (accept-and-discard): existing `autonomousMode: true` records map to `bypass` and `false` to `default`, the legacy field is scrubbed on read, and an unspecified mode defaults to `bypass` to preserve current behavior. See ADR-045.
