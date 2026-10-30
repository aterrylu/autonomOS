## ADR-160: Org Chart opens left-right with stacked reports

- **Date:** 2026-10-29
- **Decided by:** Terry (human), picking among live comparison instances built by OrgChart@autonomOS (agent).
- **Context:** The Org Chart laid every report side by side under its manager (`layout.ts`: a tidy tree, teams side by side). A team of eight workers was eight cards wide, so a modest fleet overflowed the pane at the 60% opening floor (ADR-120, ADR-159) and most of it was only reachable by panning or the map. #432 proposed two changes together: stacked reports and a redesigned "Balanced" card that added file names and icon chips. Terry compared them live, side by side, with the original cards.
- **Decision:**
  - **Stacked reports.** A lead's leaf reports hang in one column off a spine connector. Reports that lead teams of their own (or are folded teams) stay side by side, so their rollup chips keep their room. A chart grows wide with teams, not with agents. `edgePath()` draws the spine for both the edges and the message envelopes, and the arrow keys walk the column.
  - **Left-right is the default layout.** The root is on the left, each level is a column to its right, and a manager is centered on its reports. A toolbar switch (Layout: Top-down / Left-right) is remembered per browser under the `autonomos.orgchart.layout` localStorage key. Only a saved `"td"` opens top-down, so an unset or unreadable key opens left-right. In left-right the arrow keys are rotated (← manager, → first report, ↑/↓ the column) and the fold toggle sits on the card's right edge.
  - **The original card stays.** #432's Balanced card is not adopted, and #432 is closed in favor of this.
- **Rationale:** Terry, on the comparison instance that had the original cards, stacked reports and left-right: that he loved left-right being the default. He turned down the Balanced card because "the icon styling looks too different from our left agents tab/panel". The Org Chart and the sidebar show the same agents, so they should read alike. Left-right suits a wide pane: a deep chain grows rightward, and a team's stack reads like the sidebar's list.
- **Alternatives considered:**
  - Keep top-down as the default with left-right as the option: Terry picked left-right as the default. Top-down stays one click away and is remembered.
  - Ship #432 as it was (Balanced card plus stacking): rejected over the card styling (see Rationale).
  - Stack every report, including team leads: a lead's rollup chips and fold toggle need horizontal room, so only leaf reports stack.
- **Source:** Terry in the OrgChart@autonomOS CC session, 2026-10-29, after comparing live instances. Supersedes the design in PR #432 (never merged). Guards: `layout.test.ts` (stacking and left-right geometry), `HierarchyPanel.dom.test.tsx` (the default, the switch, remembered choice, rotated keys), `HierarchyPanel.canvas.dom.test.tsx` (a second team arriving below the first is shown).
