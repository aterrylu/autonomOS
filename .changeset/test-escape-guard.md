---
"@autonomos/server": patch
---

Tests can no longer touch the real ~/.autonomos: getConfigDir() now refuses to resolve the production config dir from a test process (the escape that let a bypass-mode test fixture persist into real agent state and get resurrected as a live agent by the next upgrade's boot-resume). Every config-root writer now resolves per-call through the guarded accessor (incl. two review-caught bypasses: gemini-cli's module-load freeze that also handed a stale dir to its MCP subprocess, and pinned.ts's hardcoded real path), and all previously-unisolated suites are isolated — including two whose `??=` isolation was a silent no-op for worker-run suites (agents inherit AUTONOMOS_CONFIG_DIR pointing at the REAL dir; presence is not isolation).
