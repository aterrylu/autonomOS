---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Flicker-free terminal streaming + scroll recovery (ADR-086). The PTY→WS coalescer is now trailing-edge (5ms), so a TUI repaint always arrives as one atomic frame — fixes gemini-cli's eye-hurting bottom-bar flashing (measured: 265 torn repaints/15s → 6). A pane whose viewport was accidentally scrolled into history (trackpad flick / Shift+PageUp) now shows a "↓ Jump to latest" pill — one click back to the live tail; typing also re-follows.
