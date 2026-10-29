## ADR-159: Org chart view follows the fleet when untouched or when nothing would be on screen

- **Date:** 2026-10-29
- **Decided by:** OrgChart@autonomOS (agent), as a bugfix under Terry's standing rule that bugfixes merge without his sign-off; relayed by TeamLead.
- **Supersedes:** ADR-120 (item 6, the clause "the view is never moved when agents come or go"); the rest of ADR-120 stands.
- **Context:** Terry saw two top-level teams with only ONE chain drawn, and after he removed that agent, the chart looked EMPTY while the other manager was still running. The tree data was correct everywhere (`/api/agents/tree`, `pruneExited`, the sidebar, `get_org_chart`). The cause was the canvas view. ADR-120 froze it whenever the chart changed. A team that arrived after the chart opened, or that started off-screen at the 60% opening floor, stayed off-screen. When the visible team was removed, the survivor was re-laid out outside the frozen view: drawn, but with no card on screen. A deterministic repro (two teams, the first too wide for 60%, then the first removed) showed the view at x = -228 with 0 of 2 surviving cards visible.
- **Decision:** When the drawn cards change (`useCanvasView`'s `cards`):
  - a view the user has moved since it opened or since the last Fit (pan, wheel, zoom buttons, reset, the map, a selection reveal) stays exactly where it is, as long as at least one card is still on screen;
  - otherwise the view re-opens on the fleet as it is now (`openView`: fit, with the 60% floor).

  Fit clears the "moved" state, so a fitted chart keeps framing the fleet. Visibility is checked per card (`anyRectVisible`), not on the chart's bounding box, because the chart's padding can overlap the viewport while every card is off-screen. The panel hands the canvas a new `cards` array only when a card's position changes, so a status frame that moves nothing doesn't re-check the view.
- **Rationale:** ADR-120's clause existed so the chart wouldn't jump while you read it. That still holds, because a view you placed doesn't move while it shows anything. But applied to a view nobody touched, or to one left showing nothing, the clause makes a correct fleet look missing, which is worse than any jump. Re-opening (rather than, say, a minimal pan) uses the same framing the chart opens with, so the result is predictable.
- **Alternatives considered:**
  - Always re-fit on every change: it would yank a view the user placed whenever an agent spawned or exited. That breaks ADR-120's intent, and a test now pins it.
  - Re-frame only when nothing is visible, ignoring untouched views: this fixes the empty chart but not the "second team arrived off-screen" half of the bug.
  - Lower the 60% opening floor so two wide teams always fit: that is a design change to Terry's pick 4A, not a bugfix. When a fleet is too wide for 60%, the map still shows the rest.
  - A bounding-box visibility test: it is wrong in exactly the reported case (padding overlaps, cards don't).
- **Source:** TeamLead relay of Terry's report, 2026-10-29. Fix PR `terry/orgchart-two-roots`; guards in `HierarchyPanel.canvas.dom.test.tsx` ("two top-level teams …") and `viewport.test.ts` (`anyRectVisible`).
