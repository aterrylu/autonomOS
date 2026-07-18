---
"@autonomos/dashboard": patch
---

Fix a family of dashboard "stuck states" — UI states you could get into and not recover from — surfaced by an audit of the dockview/terminal/store layer:

- **Permanent blank screen**: a corrupt persisted `activePane` (or poison workspace blob) threw during layout restore and re-persisted, blanking the app on every reload. Added a top-level `ErrorBoundary` with a two-tier "Reset layout" → "Clear all saved data" recovery (loop-detected), plus `merge()` validation that rejects malformed `activePane`/`serialized` blobs so they degrade to the empty state instead of crashing.
- **Idle terminal self-shrink**: an idle GPU context-loss re-fit could ship a plausible-but-wrong (mis-measured) size to the PTY that the ResizeObserver's change-cache then never corrected. Fitting is now plausibility-guarded (`isPlausibleFit`), retries on unsettled frames, and invalidates the cache so it can self-correct.
- **Every click rebuilds the group**: a killed/exited workspace member lingered in the saved arrangement, forcing a full teardown+rebuild on every navigation. Dead members are now reconciled out of bound workspaces on kill/exit.
- **Dock blanks on active-agent exit**: watching an agent that exits dropped you to the empty screen even with other live agents; it now retargets to a live sibling.
- **Touch drag-tracking death**: the internal-drag guard only reset on a native `dragend` (never fired by the touch/pointer backend), latching on and silently killing active-pane tracking. It now also settles on `pointerup`/`pointercancel`.
- Hardening: `reorderHierarchy` bounds guard, `handleExternalDrop` dead-session guard, and diagnostic breadcrumbs on the silent recovery paths.
