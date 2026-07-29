---
"@autonomos/core": patch
"@autonomos/server": patch
---

Remove the scheduler's `isolated` execution mode. It spawned a headless `claude -p` child outside the permission-mode system entirely and passed `--dangerously-skip-permissions` whenever `autonomous` wasn't explicitly `false` — so a schedule created without that field ran with full autonomy. It was the last execution path in the product that could grant autonomy a permission mode didn't.

Schedules now have one target, `agent:<name>`: they send their prompt to a running agent, which does the work under its own permission mode. A schedule can no longer grant autonomy, and its target agent needs to be alive when it fires.

`autonomous`, `workingDirectory`, `template` and `onComplete` are accepted and ignored rather than rejected, so existing schedule files and older MCP clients keep working. An existing `isolated` schedule still loads and stays editable, warns once at startup naming itself, and fails any run with a message pointing at `agent:<name>`. See ADR-062.
