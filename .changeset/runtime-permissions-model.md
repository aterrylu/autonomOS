---
"@autonomos/core": minor
"@autonomos/server": minor
---

Agents now carry their permission in their own CLI's values: Claude Code `manual`/`acceptEdits`/`auto`/`dontAsk`/`plan`/`bypassPermissions`, Codex `approval_policy` × `sandbox_mode` × `approvals_reviewer`, and Gemini `default`/`auto_edit`/`plan`/`yolo`. Every existing agent and template keeps exactly what it ran before. Codex agents that were set to Auto or Plan, which always ran as on-request, get a one-time notice that says so.

- `create_agent` (REST and MCP) takes `permission` in the runtime's own values, together with `provider`. A wrong value is rejected with the valid ones listed. The old `permissionMode` still works but is deprecated.
- A default per runtime is now a server setting (`runtimeDefaults`), so agents spawned by other agents use it too.
- Templates take a per-runtime `permissions` map, and the built-in templates no longer pin Ask.
- `list_agents` shows each agent's permission in its CLI's values.
