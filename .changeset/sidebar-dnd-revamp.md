---
"@autonomos/dashboard": minor
---

feat(dashboard): sidebar drag-reorder revamp — whole-row native drag (both views)

Reworks the agents-tab drag-reorder that was "not accurate, not visual enough, doesn't feel like it did what I wanted." The whole agent row stays natively draggable (no grip), and the wins that made it feel right are ported onto native HTML5 DnD (ADR-095):

- **Indicated == committed.** A midpoint hit-test (`dropEdgeAt`) decides the above/below half of the hovered row, and the gold insertion line and the commit index derive from that same edge — so a downward drag lands below the row the line was under, not one slot short. Fully unit-tested pure modules (`sidebarReorder.ts` / `hierarchyReorder.ts`).
- **Freeze at drag-start** (both views): rows/tree are snapshotted so live poll ticks can't shift the target mid-drag.
- **3px accent insertion line**, composed with the active/visible highlight (not clobbering it); **hand-rolled edge auto-scroll** so you can drag to an off-screen row.
- **Hierarchy index-space fix:** sibling reorder commits by NAME into the persisted order, so a stopped sibling holding a slot no longer moves the wrong agent (the old lazy-init + index-splice path is gone).
- The row body still drags into the terminal area to open a tab/split. Re-parent stays out of scope (the set-manager submenu is the re-parent path); the tree-guide alignment is preserved.
- e2e drives **native** `dragstart`/`dragover`/`drop` (CDP `page.mouse` never raises native drag) with a rect-matched `clientY`, RED-first verified against the accuracy bug.

Note: dnd-kit was built first and rejected at Terry's hands-on gate (the grip and broken tree-line alignment) — see ADR-095. No new runtime dependency ships.
