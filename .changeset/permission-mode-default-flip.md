---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Flip the default permission mode from `bypass` to `default` (fail-closed). A spawn that doesn't specify a `permissionMode` now **asks before each privileged action** instead of skipping all permission prompts.

The original ADR-045 cut shipped `bypass` as the default to mirror the old `autonomousMode` behavior, but that proved fragile: `bypass` emits `--dangerously-skip-permissions`, which the real Claude Code binary refuses under CI/root, and it silently granted full autonomy to any spawn that forgot to set a mode. A safe default matters more — callers that want autonomy now set `bypass` explicitly (the Settings/Create-Agent UI, MCP, and templates can all still choose it).

Migration of **existing** records is unchanged: an old `autonomousMode: true` still maps to `bypass`, so already-configured installs keep their prior behavior. Only fresh/unspecified spawns get the safe default. Also: Claude `default` mode now emits no flag (the redundant `--permission-mode default` was perturbing interactive-TUI startup timing). See ADR-045 (Update 2026-06-26).
