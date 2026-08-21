---
"@autonomos/dashboard": minor
---

feat(dashboard): draggable per-terminal usage-queue overlay

The "auto-Enter when limit resets" control no longer parks over the terminal's bottom input line. It now defaults to the pane's **top-right** and can be **dragged** by a grip handle (or nudged with arrow keys when the handle is focused). Its position is remembered **per terminal** (localStorage), clamped inside the pane, and re-clamped on pane resize so it can never be lost off-canvas. Arm/disarm behavior and the per-tab/per-runtime cap isolation (ADR-068) are unchanged.
