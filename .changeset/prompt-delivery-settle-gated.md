---
"@autonomos/server": patch
"@autonomos/core": patch
---

fix(prompt-delivery): settle-gated receipt windows — no more false "stuck" warnings or double-delivered briefs (ADR-072)

The prompt-delivery receipt's fixed 15s/20s windows measured Claude Code's TUI
boot latency, not delivery: under a multi-agent boot sweep every prompted spawn
produced a false "prompt likely dropped → re-delivery failed, agent may be
stuck" warning pair, and the paste fallback DOUBLE-DELIVERED the starting
prompt (both the argv copy and the paste queued behind the booting TUI and
both submitted). The 2026-08-08 audit caught this self-referentially — the
audit agent's own session was flagged "stuck" while running, and it received
its brief twice.

- No receipt window arms until the startup dialogs are out of the way: the
  auto-trust watcher's new `onSettled` terminal callback (fired exactly once —
  all-settled, give-up, hard timeout, or PTY death) gates the clocks;
  watcherless spawns settle immediately; a 45s fallback self-settles so a
  wiring regression can't silently disable the detector.
- Windows widened to what they actually measure: 30s settle→SessionStart, 90s
  →UserPromptSubmit (TUI + plugin attach time), 90s re-delivery confirm.
- Giving up is retractable: the tracker parks for 10min and a late receipt
  retracts the failure SystemWarning and logs the correction. Real drops are
  still recovered by the single bracketed-paste re-delivery.
