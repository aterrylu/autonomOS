---
"@autonomos/dashboard": minor
---

Key-capture boundary cleanup (ADR-065). Ctrl+D (EOF), Ctrl+W-on-Mac (delete-word) and Ctrl+B-on-Mac (tmux prefix) reach the shell again — they had been silently swallowed since the legacy split-pane shortcuts were deleted, a reservation with no owner. Escape dismissal for the help overlay, status-bar popovers and the notification panel now runs through the shortcut registry's capture-phase `ui.dismiss` entry backed by a LIFO escape stack, so Escape closes the topmost open panel even while a terminal has focus (the old bubble-phase listeners were unreachable there — xterm stops propagation), and terminals keep Escape whenever nothing is open.
