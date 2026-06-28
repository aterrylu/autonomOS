---
"@autonomos/dashboard": patch
---

Remove the legacy layout engine now that dockview is the default (ADR-047, follows #263). Deletes the hand-rolled binary-tree split system (`layoutTree`), the detached-terminal overlay (`SessionMountLayer`), the hidden `groups` workspace-swap, the `SplitLayout`/`PaneSlot`/`DropZoneOverlay`/`TabBar`/`LayoutContext` components, the `layoutEngine` flag, and the `react-resizable-panels` dependency — ~3.5k lines of fragile custom code. dockview is now the only layout engine.

No user-facing behavior change: dockview already shipped on by default and is untouched. The sidebar's on-screen-agent indicator is re-sourced from dockview's live panel set (was derived from the deleted layout tree). The legacy split/close keyboard shortcuts (Ctrl+D / Ctrl+Shift+D / Ctrl+W) are removed — dockview-native keybinds are a planned follow-up.
