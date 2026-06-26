---
"@autonomos/server": patch
---

Quarantine the `usage-queue-sim-integration` test pending a fix for the auto-trust ↔ TUI-stdin-attachment race (ADR-036 / PR #209). The test types the prompt over the terminal WebSocket and relies on the usage-queue's auto-Enter; unlike production agent spawns it does not route through the prompt-delivery receipt mechanism, so it's exposed to the documented race that mechanism is designed to absorb. The quarantine is observable in code (a `skip: true` with a header comment explaining the cause and exit criteria) and reversible once either the race is fixed upstream or the test is re-routed through the receipt path.
