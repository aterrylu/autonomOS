---
"@autonomos/dashboard": minor
---

feat(dashboard): sidebar drag-reorder revamp — whole-row native drag (both views)

Reworks the agents-tab drag-reorder that was "not accurate, not visual enough, doesn't feel like it did what I wanted." The whole agent row stays natively draggable (no grip), and the wins that made it feel right are ported onto native HTML5 DnD (ADR-095):

- **Indicated == committed.** A midpoint hit-test (`dropEdgeAt`) decides the above/below half of the hovered row, and the slide-apart gap and the commit index derive from that same boundary (`insertionBoundary`) — so a downward drag lands where the gap opened, not one slot short. Fully unit-tested pure modules (`sidebarReorder.ts` / `hierarchyReorder.ts`).
- **Freeze at drag-start** (both views): rows/tree are snapshotted so live poll ticks can't shift the target mid-drag.
- **Slide-apart + ghost preview** (both views): the rows below the boundary push away to open a one-row gap, a ghost of the dragged agent previews in the gap, and the origin row dims — replacing the gold insertion line Terry rejected on re-test. A real-height ghost spliced at the boundary opens the gap via layout (subtrees included, no per-row transforms); its height animates open. **Hand-rolled edge auto-scroll** so you can drag to an off-screen row; `dragleave` of the sidebar clears the gap for drag-into-dockview.
- **Affordance continuity at the origin slot:** when the hover lands the row back where it started (a no-op, so no gap opens), the origin row *itself* takes the dashed-preview styling (a no-reflow `outline`, at full opacity) instead of dimming — so there is always **exactly one** dashed "will land here" marker, including 'right back where it started.' Derived from the SAME no-op the commit computes (`flatDropIndex`/`hierDropIndex` return null iff the drop lands at origin), so origin-dash and the in-gap ghost are mutually exclusive by construction.
- **Hierarchy index-space fix:** sibling reorder commits by NAME into the persisted order, so a stopped sibling holding a slot no longer moves the wrong agent (the old lazy-init + index-splice path is gone).
- The row body still drags into the terminal area to open a tab/split. Re-parent stays out of scope (the set-manager submenu is the re-parent path); the tree-guide alignment is preserved.
- e2e drives **native** `dragstart`/`dragover`/`drop` (CDP `page.mouse` never raises native drag) with a rect-matched `clientY`, RED-first verified against the accuracy bug.

Note: dnd-kit was built first and rejected at Terry's hands-on gate (the grip and broken tree-line alignment) — see ADR-095. No new runtime dependency ships.
