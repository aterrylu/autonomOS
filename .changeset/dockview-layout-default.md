---
"@autonomos/dashboard": minor
---

Rebuild the terminal tabs + split-pane layout on **dockview**, and make it the default. The hand-rolled binary-tree layout, the detached-terminal overlay (`SessionMountLayer`), and the hidden `groups` workspace-swap are replaced by a dockview-react dock that owns the pane topology (ADR-047). dockview's `renderer: "always"` keeps every terminal's xterm mounted across tab switches, retiring the most fragile hand-rolled system — the manual rect-flying overlay.

What changes for you:
- **Click = navigate, drag = compose.** Clicking a sidebar agent (or Org Chart / Templates / Schedules / New Agent) opens it **solo** in its own group. Dragging one into the pane area composes a tab or split — and that arrangement is **saved as a bound workspace**: click any of its members later and the whole group is restored, persisted across reloads (and a cold reload restores exactly what you were last viewing). Drag works from both the flat and hierarchical sidebar views.
- **Cleaner chrome.** Tab titles match the sidebar size, the active tab is outlined with the app's hairline divider, terminals fill their panel edge-to-edge, and dockview's redundant per-group "tab overflow" dropdown is hidden. Dragging the highlighted tab no longer shows a phantom split overlay (you can't split a pane against itself).

Two terminal bugs fixed along the way:
- **Sidebar active-highlight no longer flickers** between agents while you move/split tabs (the dockview→store sync now ignores the transient mid-drag activations and applies only the final one).
- **Terminals no longer slowly shrink to a tiny size after the session sits idle.** Hidden panels now get a real `display:none`, which restores the visibility check that disposes their WebGL context and skips fitting — preventing the GPU context-loss storm and mis-measured refits that drove the shrink. Hardened further: degenerate resizes are never sent to the PTY, and a re-fit is scheduled after a WebGL context recreate.

The legacy layout engine remains available behind the `layoutEngine` flag (`'legacy' | 'dockview'`) as a fallback.
