---
"@autonomos/dashboard": patch
---

Codex no longer jumps to the top of the scrollback when you click back into the dashboard (ADR-087). The window-focus "repaint nudge" (a fake cols−1 resize) made Codex's TUI wipe and rebuild its scrollback on every refocus, stranding a parked viewport at the absolute top. The nudge is gone, and if an app genuinely wipes its scrollback mid-read (real resizes still trigger Codex's rebuild), the viewport now lands at the live tail instead of the top.
