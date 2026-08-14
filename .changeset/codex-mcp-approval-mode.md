---
"@autonomos/server": patch
---

fix(codex): stop the per-session MCP approval prompt — mode-aware pre-approval + read-only tool annotations (ADR-085)

- Codex re-prompted to approve the autonomOS MCP server on every new session because Codex's `default_tools_approval_mode` defaults to `auto` (which prompts for un-annotated tools) and we set neither an approval mode nor annotations. The daemon now sets a mode-aware `mcp_servers.autonomos.default_tools_approval_mode`: `approve` for bypass/auto, `writes` for ask/plan — so an autonomous agent never prompts while a supervised (ask/plan) agent is still asked before mutating tools but not before reads.
- The 6 read-only tools (`list_agents`, `get_org_chart`, `list_templates`, `list_schedules`, `get_schedule`, `list_env_presets`) now declare `readOnlyHint: true`, propagated through both MCP servers (channel + HTTP). Under `writes` these are auto-approved, and Claude Code uses the hint for parallel-execution eligibility.
