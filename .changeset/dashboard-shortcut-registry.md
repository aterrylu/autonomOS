---
"@autonomos/dashboard": minor
---

Keyboard shortcut system for the dashboard: mod+1–8 focus the Nth open pane in visual order, mod+9 focuses the last pane (⌘ on Mac, Ctrl elsewhere), mod+B toggles the sidebar, and mod+/ opens a shortcut cheatsheet overlay rendered straight from the registry.

Shortcuts live in a central registry (`src/shortcuts/registry.ts`) consumed by exactly two enforcement points: a single window-level capture-phase dispatcher (which is what wins over a focused terminal — xterm stopPropagation()s handled keys in the bubble phase) and a consult in xterm's custom key handler that declines app-reserved chords, keeping the terminal's decline list mechanically synchronized with the registry. Everything unregistered passes through to the terminal untouched; Escape is app-reserved only while the overlay is open. Pane enumeration walks `api.toJSON().grid.root` for true visual order — `api.panels` is group-insertion order and lands positional shortcuts on the wrong pane after asymmetric splits. Fixes the pre-existing bug where Cmd/Ctrl+B fired on the login screen over the password field. See ADR-063.
