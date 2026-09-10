---
"@autonomos/dashboard": minor
"@autonomos/server": minor
"@autonomos/core": minor
---

feat: Projects panel revamp — provider-aware rows + nine bug fixes

Promotes the Projects rows to parity with the live agent rows (they were a flatter, CC-only copy), in a distinct "archive" treatment (ADR-098).

- **Provider-aware rows.** Each row shows a real provider glyph (Claude / Codex / Gemini) via the existing `ProviderAgentIcon`, a resolved title, a `cwd · branch` meta line, and a status pill — replacing the old 6px color-only dot. Three states: **Live ↗** (our running agent — a subordinate chip that jumps to the pane), **Stopped** (our exited agent — resume with config), **Resume** (an external/dormant session — the adoptable star).
- **Header.** A `projects · sessions` count and a collapse-all control; expand state lives in the store so it survives the Sidebar's unmount-on-collapse and persists across reloads.
- **Codex-ready wire model.** `ProjectSession` gains `provider` (+ optional `originator`); the route sets `provider:"claude-code"` and exposes a `listCodexSessions()` seam so Codex rows slot in when CodexGemini's discovery backend lands (this UI renders CC-only until then, already provider-shaped). Ships as one bundle.
- **Nine bug fixes:** structural CC-only (the revamp); the "+" quick-spawn now uses the project's own provider (it always made a Claude agent); consistent row state; the misnamed redundant `customTitle` wire field removed; live rows' age reads hook-driven `lastActivityAt` (not the lagging 30s poll mtime); cwd-less sessions no longer merge into one "Unknown"; persisted expand; no empty project name.

Tests: server route (provider tag, codex-seam merge, cwd-less separation, title resolution) + a `ProjectItem` dom test (live→jump vs external→resume, Stopped state, store-routed expand).
